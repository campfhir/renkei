import type { Server } from 'node:http';
import { openSandboxEnv } from '@renkei/connector-sandbox';
import { createHttpStoreTransport, createMemoryDataStore, createRemoteDataStore } from '@renkei/db';
import { isRecord } from '@renkei/guards';
import {
  FakeSandboxProvider,
  Orchestrator,
  OrchestratorError,
  sandboxApiKey,
} from '@renkei/sandbox-orchestrator';
import { createOrchestratorServer } from './server';

/** A response's JSON body as a record ({} when it is not one). */
async function record(response: Response): Promise<Record<string, unknown>> {
  const body: unknown = await response.json();
  return isRecord(body) ? body : {};
}

const silent = { info: () => undefined, warn: () => undefined, error: () => undefined };

async function start() {
  const data = createMemoryDataStore();
  const provider = new FakeSandboxProvider();
  const orchestrator = new Orchestrator({
    provider,
    store: () => data.sandboxes,
    masterKey: 'master',
    env: { DELEGATE_WORKER_API_KEY: 'delegate-s3cret' },
    logger: silent,
    probe: async () => ({ ok: true, capabilities: { browser: true, scripts: 'isolated' } }),
  });
  const state: { problem: string | null } = { problem: null };
  const checked: unknown[] = [];
  const server: Server = createOrchestratorServer({
    apiKeys: ['caller-key'],
    orchestrator: () => {
      if (state.problem) throw new OrchestratorError('provider', state.problem);
      return orchestrator;
    },
    status: () => ({ provider: state.problem ? null : provider.name, problem: state.problem }),
    store: () => data.sandboxes,
    dataStore: () => data,
    check: async (candidate) => {
      checked.push(candidate);
      return { ok: true, detail: 'Reached it.' };
    },
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
  const post = (path: string, body: unknown, key = 'caller-key') =>
    fetch(`${base}${path}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  return { base, post, provider, server, state, checked, data };
}

describe('the orchestrator’s HTTP surface', () => {
  let running: Awaited<ReturnType<typeof start>>;
  beforeEach(async () => {
    running = await start();
  });
  afterEach(async () => {
    await new Promise((resolve) => running.server.close(resolve));
  });

  it('answers where a scope’s sandbox is and the key it takes, making it on the first ask', async () => {
    const response = await running.post('/v1/ensure', { key: 'ann' });
    expect(response.status).toBe(200);
    const body = await record(response);
    expect(body.url).toBe('http://m1.sandbox.test:8092');
    expect(body.key).toBe(sandboxApiKey('master', String(body.sandboxId)));
    const again = await record(await running.post('/v1/ensure', { key: 'ann' }));
    expect(again).toEqual(body);
    expect(running.provider.machines.size).toBe(1);
  });

  it('refuses a caller without the key, and a request that names no scope', async () => {
    expect((await running.post('/v1/ensure', { key: 'ann' }, 'wrong')).status).toBe(401);
    const missing = await running.post('/v1/ensure', {});
    expect(missing.status).toBe(400);
    expect(await missing.json()).toEqual({
      error: { type: 'bad_request', message: 'key is required' },
    });
    expect(running.provider.machines.size).toBe(0);
  });

  it('says a provider failure is the provider’s, in the shape the sandbox client reads', async () => {
    running.provider.failNext.create = 'quota exceeded';
    const response = await running.post('/v1/ensure', { key: 'ann' });
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({
      error: { type: 'provider', message: 'quota exceeded' },
    });
  });

  it('reports what sandboxes can do on /health once one has come up, without a key', async () => {
    const before = await record(await fetch(`${running.base}/health`));
    expect(before).toEqual({ ok: true, orchestrator: true, provider: 'fake' });
    await running.post('/v1/ensure', { key: 'ann' });
    const after = await record(await fetch(`${running.base}/health`));
    expect(after).toEqual({
      ok: true,
      orchestrator: true,
      provider: 'fake',
      capabilities: { browser: true, scripts: 'isolated' },
    });
  });

  it('lists the sandboxes there are, a running one with its address and key', async () => {
    await running.post('/v1/ensure', { key: 'ann' });
    await running.post('/v1/ensure', { key: 'agent:a1' });
    const listed = await record(await running.post('/v1/list', {}));
    const sandboxes = Array.isArray(listed.sandboxes) ? listed.sandboxes.filter(isRecord) : [];
    expect(sandboxes.map((sandbox) => [sandbox.routeKey, sandbox.kind, sandbox.state])).toEqual(
      expect.arrayContaining([
        ['ann', 'user', 'running'],
        ['agent:a1', 'agent', 'running'],
      ])
    );
    expect(sandboxes).toHaveLength(2);
    expect(sandboxes.every((sandbox) => sandbox.url && sandbox.key)).toBe(true);
  });

  it('answers a call sent to it in place of a sandbox that could not be brought up with the reason, whatever the call was', async () => {
    const starting = await running.post('/unavailable/starting/v1/list', { subject: 'ann' });
    expect(starting.status).toBe(503);
    expect(await starting.json()).toMatchObject({ error: { type: 'sandbox_starting' } });
    const failed = await fetch(`${running.base}/unavailable/provider/v1/previews/proxy/web/`, {
      headers: { authorization: 'Bearer caller-key' },
    });
    expect(failed.status).toBe(502);
    expect(await failed.json()).toMatchObject({ error: { type: 'sandbox_unavailable' } });
  });

  it('answers what a call to the sandbox must carry, with its address', async () => {
    const body = await record(await running.post('/v1/ensure', { key: 'ann' }));
    expect(body.headers).toEqual({
      authorization: `Bearer ${String(body.key)}`,
      'x-sandbox-key': body.key,
    });
  });

  it('opens a preview port to named people where the provider can, and says so where it cannot', async () => {
    expect(
      await record(
        await running.post('/v1/expose', { key: 'ann', port: 5173, emails: ['ada@contoso.com'] })
      )
    ).toEqual({ url: null });
    running.provider.exposePort = async (providerId, port) => ({
      url: `https://${providerId}-${port}.example`,
    });
    expect(
      await record(
        await running.post('/v1/expose', { key: 'ann', port: 5173, emails: ['ada@contoso.com'] })
      )
    ).toEqual({ url: 'https://m1-5173.example' });
    expect((await running.post('/v1/expose', { key: 'ann', port: 5173, emails: [] })).status).toBe(
      400
    );
    expect((await running.post('/v1/expose', { key: 'ann' })).status).toBe(400);
  });

  it('says why no sandbox can be made when the organization has not set sandboxes up, on every call and on /health', async () => {
    running.state.problem = 'sandboxes are not set up yet';
    const response = await running.post('/v1/ensure', { key: 'ann' });
    expect(response.status).toBe(502);
    expect(await record(response)).toEqual({
      error: { type: 'provider', message: 'sandboxes are not set up yet' },
    });
    expect(await record(await fetch(`${running.base}/health`))).toEqual({
      ok: true,
      orchestrator: true,
      provider: null,
      problem: 'sandboxes are not set up yet',
    });
  });

  it('tries a configuration it is handed, or the stored one, without needing an orchestrator in force', async () => {
    running.state.problem = 'sandboxes are not set up yet';
    const tried = await running.post('/v1/check', {
      settings: { provider: 'docker' },
      secrets: { 'env.DATABASE_URL': 'postgres://x', odd: 7 },
    });
    expect(await record(tried)).toEqual({ ok: true, detail: 'Reached it.' });
    await running.post('/v1/check', {});
    expect(running.checked).toEqual([
      { settings: { provider: 'docker' }, secrets: { 'env.DATABASE_URL': 'postgres://x' } },
      null,
    ]);
    expect((await running.post('/v1/check', {}, 'wrong')).status).toBe(401);
  });

  it('removes a scope’s sandbox on request', async () => {
    await running.post('/v1/ensure', { key: 'ann' });
    expect(await (await running.post('/v1/remove', { key: 'ann' })).json()).toEqual({
      removed: true,
    });
    expect(running.provider.machines.size).toBe(0);
    expect(await (await running.post('/v1/remove', { key: 'ann' })).json()).toEqual({
      removed: false,
    });
  });
});

describe('what a sandbox itself may ask of the orchestrator', () => {
  let running: Awaited<ReturnType<typeof start>>;
  let ann: { sandboxId: string; key: string };
  let bob: { sandboxId: string; key: string };
  const made = async (key: string) => {
    const body = await record(await running.post('/v1/ensure', { key }));
    return { sandboxId: String(body.sandboxId), key: String(body.key) };
  };
  const asSandbox = (who: { sandboxId: string; key: string }, path: string, body: unknown = {}) =>
    fetch(`${running.base}/sandbox/v1/${path}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${who.key}`,
        'x-sandbox-id': who.sandboxId,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    });

  beforeEach(async () => {
    running = await start();
    ann = await made('ann');
    bob = await made('bob');
  });
  afterEach(async () => {
    await new Promise((resolve) => running.server.close(resolve));
  });

  it('is its secrets, sealed under its own key: on the wire they are ciphertext, and no other sandbox opens them', async () => {
    const response = await asSandbox(ann, 'bootstrap');
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).not.toContain('delegate-s3cret');
    const sealed = String(JSON.parse(text).sealed);
    expect(openSandboxEnv(ann.key, ann.sandboxId, sealed)).toEqual({
      DELEGATE_WORKER_API_KEY: 'delegate-s3cret',
    });
    expect(openSandboxEnv(bob.key, bob.sandboxId, sealed)).toBeNull();
  });

  it('is its own rows in the data store, with no database connection of its own', async () => {
    const store = createRemoteDataStore(
      createHttpStoreTransport({ url: running.base, sandboxId: ann.sandboxId, sandboxKey: ann.key })
    );
    const expiresAt = new Date(Date.UTC(2026, 0, 2));
    await store.sandboxFiles.insert({
      id: '00000000-0000-4000-8000-000000000001',
      subject: 'ann',
      scope: '',
      filename: 'notes.txt',
      contentType: 'text/plain',
      sizeBytes: 12,
      storageKey: 'k',
      source: 'test',
      batchId: null,
      expiresAt,
    });
    const listed = await store.sandboxFiles.list('ann', '');
    expect(listed.map((file) => [file.filename, file.expiresAt])).toEqual([
      ['notes.txt', expiresAt],
    ]);
    // It landed in the orchestrator's store.
    expect(await running.data.sandboxFiles.list('ann', '')).toHaveLength(1);
  });

  it('is refused everything else in the store: people, chats, other sandboxes, the stored setup', async () => {
    const store = createRemoteDataStore(
      createHttpStoreTransport({ url: running.base, sandboxId: ann.sandboxId, sandboxKey: ann.key })
    );
    await expect(store.identities.get('ann')).rejects.toThrow(/not a call a sandbox may make/);
    await expect(store.sandboxes.live('bob')).rejects.toThrow(/not a call a sandbox may make/);
    await expect(store.connectorConfigs.get('sandbox-orchestrator')).rejects.toThrow(
      /not a call a sandbox may make/
    );
    await expect(store.settings.set('log_level', 'debug')).rejects.toThrow(
      /not a call a sandbox may make/
    );
  });

  it('is nothing for a caller that is not that sandbox: a wrong key, another sandbox’s key, the callers’ key, a removed sandbox', async () => {
    expect((await asSandbox({ sandboxId: ann.sandboxId, key: 'wrong' }, 'bootstrap')).status).toBe(
      401
    );
    expect((await asSandbox({ sandboxId: ann.sandboxId, key: bob.key }, 'bootstrap')).status).toBe(
      401
    );
    expect((await asSandbox({ sandboxId: ann.sandboxId, key: 'caller-key' }, 'store')).status).toBe(
      401
    );
    await running.post('/v1/remove', { key: 'ann' });
    expect((await asSandbox(ann, 'bootstrap')).status).toBe(401);
  });

  it('opens none of the callers’ operations with a sandbox’s key', async () => {
    expect((await running.post('/v1/list', {}, ann.key)).status).toBe(401);
    expect((await running.post('/v1/ensure', { key: 'bob' }, ann.key)).status).toBe(401);
    expect((await running.post('/v1/check', {}, ann.key)).status).toBe(401);
  });
});
