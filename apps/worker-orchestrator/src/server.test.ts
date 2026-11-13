import type { Server } from 'node:http';
import { createMemoryDataStore } from '@renkei/db';
import { isRecord } from '@renkei/guards';
import { FakeSandboxProvider, Orchestrator, sandboxApiKey } from '@renkei/sandbox-orchestrator';
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
    env: {},
    logger: silent,
    probe: async () => ({ ok: true, capabilities: { browser: true, scripts: 'isolated' } }),
  });
  const server: Server = createOrchestratorServer({
    apiKeys: ['caller-key'],
    orchestrator,
    store: () => data.sandboxes,
    providerName: provider.name,
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
  return { base, post, provider, server };
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
