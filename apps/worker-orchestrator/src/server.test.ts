import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createMemoryDataStore } from '@renkei/db';
import { FakeSandboxProvider, Orchestrator, sandboxApiKey } from '@renkei/sandbox-orchestrator';
import { createOrchestratorServer } from './server';

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
    masterKey: 'master',
    providerName: provider.name,
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
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
    const body = (await response.json()) as { sandboxId: string; url: string; key: string };
    expect(body.url).toBe('http://m1.sandbox.test:8092');
    expect(body.key).toBe(sandboxApiKey('master', body.sandboxId));
    const again = (await (await running.post('/v1/ensure', { key: 'ann' })).json()) as typeof body;
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
    const before = (await (await fetch(`${running.base}/health`)).json()) as object;
    expect(before).toEqual({ ok: true, orchestrator: true, provider: 'fake' });
    await running.post('/v1/ensure', { key: 'ann' });
    const after = (await (await fetch(`${running.base}/health`)).json()) as object;
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
    const listed = (await (await running.post('/v1/list', {})).json()) as {
      sandboxes: Array<{ routeKey: string; kind: string; state: string; url?: string; key?: string }>;
    };
    expect(listed.sandboxes.map((sandbox) => [sandbox.routeKey, sandbox.kind, sandbox.state])).toEqual(
      expect.arrayContaining([
        ['ann', 'user', 'running'],
        ['agent:a1', 'agent', 'running'],
      ])
    );
    expect(listed.sandboxes.every((sandbox) => sandbox.url && sandbox.key)).toBe(true);
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
