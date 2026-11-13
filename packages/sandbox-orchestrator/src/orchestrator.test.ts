import { createMemoryDataStore } from '@renkei/db';
import { FakeSandboxProvider } from './fake-provider';
import { sandboxApiKey } from './keys';
import { Orchestrator, OrchestratorError } from './orchestrator';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

function setup(overrides: { probe?: (address: string) => Promise<unknown | null> } = {}) {
  const clock = { now: Date.UTC(2026, 0, 1) };
  const data = createMemoryDataStore();
  const provider = new FakeSandboxProvider(() => clock.now);
  const logs: string[] = [];
  const log = (level: string) => (message: string) => void logs.push(`${level}: ${message}`);
  let ids = 0;
  const orchestrator = new Orchestrator({
    provider,
    store: () => data.sandboxes,
    masterKey: 'master',
    env: { DATABASE_URL: 'postgres://sandbox', SANDBOX_WORKER_API_KEY: 'from-template' },
    logger: { info: log('info'), warn: log('warn'), error: log('error') },
    now: () => clock.now,
    sleep: async (ms) => {
      clock.now += ms;
    },
    newId: () => `00000000-0000-4000-8000-${String((ids += 1)).padStart(12, '0')}`,
    probe: overrides.probe ?? (async () => ({ ok: true, capabilities: { browser: true } })),
  });
  return { clock, data, provider, orchestrator, logs };
}

describe('a call for a scope', () => {
  it('makes the scope a sandbox the first time, and answers where it is and the key it takes', async () => {
    const { orchestrator, provider, data } = setup();
    const endpoint = await orchestrator.ensure('ann');
    expect(endpoint.url).toBe('http://m1.sandbox.test:8092');
    expect(endpoint.key).toBe(sandboxApiKey('master', endpoint.sandboxId));
    expect(provider.calls).toEqual([`create:${endpoint.sandboxId}`]);
    expect(await data.sandboxes.live('ann')).toMatchObject({
      state: 'running',
      kind: 'user',
      provider: 'fake',
      providerId: 'm1',
      address: endpoint.url,
    });
  });

  it('starts the worker with the template environment, its own key and its id — which the template cannot override', async () => {
    const { orchestrator, provider } = setup();
    const endpoint = await orchestrator.ensure('ann');
    expect(provider.machines.get('m1')?.env).toEqual({
      DATABASE_URL: 'postgres://sandbox',
      SANDBOX_WORKER_API_KEY: endpoint.key,
      SANDBOX_WORKER_PORT: '8092',
      SANDBOX_ORCHESTRATED: '1',
      SANDBOX_INSTANCE_ID: endpoint.sandboxId,
    });
  });

  it('gives a person, an agent and a project each a sandbox of their own, and the same one on the next call', async () => {
    const { orchestrator, provider, data } = setup();
    const person = await orchestrator.ensure('ann');
    const agent = await orchestrator.ensure('agent:a1');
    const project = await orchestrator.ensure('code-project:p1');
    expect(new Set([person.url, agent.url, project.url]).size).toBe(3);
    expect((await orchestrator.ensure('ann')).url).toBe(person.url);
    expect(provider.machines.size).toBe(3);
    expect((await data.sandboxes.live('agent:a1'))?.kind).toBe('agent');
    expect((await data.sandboxes.live('code-project:p1'))?.kind).toBe('project');
  });

  it('makes one sandbox when two calls for the same scope arrive together', async () => {
    const { orchestrator, provider } = setup();
    const [first, second] = await Promise.all([
      orchestrator.ensure('ann'),
      orchestrator.ensure('ann'),
    ]);
    expect(first).toEqual(second);
    expect(provider.machines.size).toBe(1);
  });

  it('waits for a sandbox another orchestrator is making rather than making a second', async () => {
    const { orchestrator, provider, data, clock } = setup();
    const theirs = await data.sandboxes.claim({
      id: '00000000-0000-4000-8000-0000000000aa',
      routeKey: 'ann',
      kind: 'user',
      provider: 'fake',
      at: new Date(clock.now),
    });
    const waiting = orchestrator.ensure('ann');
    await data.sandboxes.transition({
      id: theirs!.id,
      from: ['provisioning'],
      to: 'running',
      at: new Date(clock.now),
      providerId: 'theirs',
      address: 'http://theirs:8092',
    });
    expect((await waiting).url).toBe('http://theirs:8092');
    expect(provider.calls).toEqual([]);
  });

  it('refuses a key that names no scope', async () => {
    const { orchestrator } = setup();
    await expect(orchestrator.ensure('')).rejects.toMatchObject({ type: 'bad_request' });
    await expect(orchestrator.ensure('a\nb')).rejects.toMatchObject({ type: 'bad_request' });
  });

  it('records activity, so a sandbox in use is not idle', async () => {
    const { orchestrator, data, clock } = setup();
    await orchestrator.ensure('ann');
    clock.now += 10 * MINUTE;
    await orchestrator.ensure('ann');
    expect((await data.sandboxes.live('ann'))?.lastActiveAt.getTime()).toBe(clock.now);
  });

  it('remembers what the sandbox said it can do', async () => {
    const { orchestrator } = setup();
    expect(orchestrator.health()).toBeNull();
    await orchestrator.ensure('ann');
    expect(orchestrator.health()).toEqual({ ok: true, capabilities: { browser: true } });
  });
});

describe('a sandbox that cannot be made', () => {
  it('fails the call, leaves no machine, and the next call tries afresh', async () => {
    const { orchestrator, provider, data, logs } = setup();
    provider.failNext.create = 'quota exceeded';
    await expect(orchestrator.ensure('ann')).rejects.toMatchObject({
      type: 'provider',
      message: 'quota exceeded',
    });
    expect(await data.sandboxes.live('ann')).toBeNull();
    expect(provider.machines.size).toBe(0);
    expect(logs.some((line) => line.startsWith('error:'))).toBe(true);
    expect((await orchestrator.ensure('ann')).url).toBe('http://m1.sandbox.test:8092');
  });

  it('gives up on one whose worker never answers, removes it, and says to try again', async () => {
    const { orchestrator, provider, data } = setup({ probe: async () => null });
    const failure = await orchestrator.ensure('ann').catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(OrchestratorError);
    expect(failure).toMatchObject({ type: 'starting' });
    expect(provider.machines.size).toBe(0);
    expect(await data.sandboxes.live('ann')).toBeNull();
  });
});

describe('an idle sandbox', () => {
  it('is suspended once nothing has called it for a quarter of an hour, and not before', async () => {
    const { orchestrator, provider, data, clock } = setup();
    await orchestrator.ensure('ann');
    clock.now += 14 * MINUTE;
    expect((await orchestrator.sweep()).suspended).toBe(0);
    clock.now += 2 * MINUTE;
    expect((await orchestrator.sweep()).suspended).toBe(1);
    expect(provider.machines.get('m1')?.state).toBe('suspended');
    expect(await data.sandboxes.live('ann')).toMatchObject({ state: 'suspended', address: null });
  });

  it('is resumed, not remade, by the next call', async () => {
    const { orchestrator, provider, clock } = setup();
    const before = await orchestrator.ensure('ann');
    clock.now += 16 * MINUTE;
    await orchestrator.sweep();
    const after = await orchestrator.ensure('ann');
    expect(after).toEqual(before);
    expect(provider.calls).toEqual([`create:${before.sandboxId}`, 'suspend:m1', 'resume:m1']);
  });

  it('keeps running when the provider cannot suspend it, and is tried again', async () => {
    const { orchestrator, provider, data, clock } = setup();
    await orchestrator.ensure('ann');
    clock.now += 16 * MINUTE;
    provider.failNext.suspend = 'engine busy';
    expect(await orchestrator.sweep()).toMatchObject({ suspended: 0, failures: 1 });
    expect((await data.sandboxes.live('ann'))?.state).toBe('running');
    expect((await orchestrator.sweep()).suspended).toBe(1);
  });

  it('is removed with everything it held once it has been idle for a day', async () => {
    const { orchestrator, provider, data, clock } = setup();
    const first = await orchestrator.ensure('ann');
    clock.now += 16 * MINUTE;
    await orchestrator.sweep();
    clock.now += 23 * HOUR;
    expect((await orchestrator.sweep()).removed).toBe(0);
    clock.now += HOUR;
    expect((await orchestrator.sweep()).removed).toBe(1);
    expect(provider.machines.size).toBe(0);
    expect(await data.sandboxes.live('ann')).toBeNull();
    expect((await data.sandboxes.get(first.sandboxId))?.state).toBe('deleted');
    // The next call starts over with a new sandbox.
    const second = await orchestrator.ensure('ann');
    expect(second.sandboxId).not.toBe(first.sandboxId);
  });

  it('that is still in use by another scope is left alone', async () => {
    const { orchestrator, provider, clock } = setup();
    await orchestrator.ensure('ann');
    clock.now += 10 * MINUTE;
    await orchestrator.ensure('bob');
    clock.now += 6 * MINUTE;
    await orchestrator.sweep();
    expect(provider.machines.get('m1')?.state).toBe('suspended');
    expect(provider.machines.get('m2')?.state).toBe('running');
  });

  it('whose record is forgotten a week after it was removed', async () => {
    const { orchestrator, data, clock } = setup();
    const first = await orchestrator.ensure('ann');
    await orchestrator.remove('ann', 'an administrator removed it');
    clock.now += 8 * 24 * HOUR;
    expect((await orchestrator.sweep()).purged).toBe(1);
    expect(await data.sandboxes.get(first.sandboxId)).toBeNull();
  });
});

describe('a sandbox the provider changed by itself', () => {
  it('that the platform suspended is resumed on the next call', async () => {
    const { orchestrator, provider, clock } = setup();
    const before = await orchestrator.ensure('ann');
    provider.machines.get('m1')!.state = 'suspended';
    clock.now += MINUTE;
    expect(await orchestrator.ensure('ann')).toEqual(before);
    expect(provider.calls).toContain('resume:m1');
  });

  it('that is gone is replaced on the next call', async () => {
    const { orchestrator, provider, clock, logs } = setup();
    const before = await orchestrator.ensure('ann');
    provider.machines.clear();
    clock.now += MINUTE;
    const after = await orchestrator.ensure('ann');
    expect(after.sandboxId).not.toBe(before.sandboxId);
    expect(logs.some((line) => line.startsWith('warn:'))).toBe(true);
  });

  it('is believed for half a minute without asking, unless the caller says its call did not connect', async () => {
    const { orchestrator, provider, clock } = setup();
    const before = await orchestrator.ensure('ann');
    provider.machines.clear();
    clock.now += 10_000;
    expect(await orchestrator.ensure('ann')).toEqual(before);
    const after = await orchestrator.ensure('ann', { verify: true });
    expect(after.sandboxId).not.toBe(before.sandboxId);
  });
});

describe('housekeeping', () => {
  it('finishes a suspend whose orchestrator died half way', async () => {
    const { orchestrator, provider, data, clock } = setup();
    const endpoint = await orchestrator.ensure('ann');
    await data.sandboxes.transition({
      id: endpoint.sandboxId,
      from: ['running'],
      to: 'suspending',
      at: new Date(clock.now),
    });
    provider.machines.get('m1')!.state = 'suspended';
    clock.now += 11 * MINUTE;
    expect((await orchestrator.sweep()).recovered).toBe(1);
    expect((await data.sandboxes.live('ann'))?.state).toBe('suspended');
  });

  it('removes a sandbox abandoned while it was being made, machine and all', async () => {
    const { orchestrator, provider, data, clock } = setup();
    const row = await data.sandboxes.claim({
      id: '00000000-0000-4000-8000-0000000000bb',
      routeKey: 'ann',
      kind: 'user',
      provider: 'fake',
      at: new Date(clock.now),
    });
    await provider.create({
      sandboxId: row!.id,
      kind: 'user',
      env: {},
      idleSuspendSeconds: 900,
      idleDeleteSeconds: 86_400,
    });
    clock.now += 11 * MINUTE;
    expect((await orchestrator.sweep()).recovered).toBe(1);
    expect(provider.machines.size).toBe(0);
    expect(await data.sandboxes.live('ann')).toBeNull();
  });

  it('removes a machine that has no record, once it is old enough not to be one just made', async () => {
    const { orchestrator, provider, clock } = setup();
    await provider.create({
      sandboxId: '00000000-0000-4000-8000-0000000000cc',
      kind: 'user',
      env: {},
      idleSuspendSeconds: 900,
      idleDeleteSeconds: 86_400,
    });
    expect((await orchestrator.sweep()).orphans).toBe(0);
    clock.now += 11 * MINUTE;
    expect((await orchestrator.sweep()).orphans).toBe(1);
    expect(provider.machines.size).toBe(0);
  });

  it('removes a scope’s sandbox on request, and says so when there was none', async () => {
    const { orchestrator, provider } = setup();
    await orchestrator.ensure('ann');
    expect(await orchestrator.remove('ann')).toBe(true);
    expect(provider.machines.size).toBe(0);
    expect(await orchestrator.remove('ann')).toBe(false);
  });
});
