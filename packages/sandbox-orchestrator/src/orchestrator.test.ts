import { createMemoryDataStore } from '@renkei/db';
import { FakeSandboxProvider } from './fake-provider';
import { sandboxApiKey } from './keys';
import { Orchestrator, OrchestratorError } from './orchestrator';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** A blob store in memory, and sandboxes whose whole contents are one string each. */
function archiveFakes(provider: FakeSandboxProvider) {
  const blobs = new Map<string, Uint8Array>();
  /** What each machine holds, by its address. */
  const contents = new Map<string, string>();
  const failNext: { put?: string; download?: string; upload?: string } = {};
  const fail = (name: 'put' | 'download' | 'upload') => {
    const message = failNext[name];
    if (message === undefined) return;
    delete failNext[name];
    throw new Error(message);
  };
  const holdOf = (providerId: string) => contents.get(provider.addressOf(providerId));
  return {
    blobs,
    contents,
    failNext,
    holdOf,
    write: (providerId: string, text: string) =>
      void contents.set(provider.addressOf(providerId), text),
    archiveBlobs: {
      async put(key: string, body: AsyncIterable<Uint8Array>) {
        const parts: Uint8Array[] = [];
        for await (const part of body) parts.push(part);
        fail('put');
        const bytes = Buffer.concat(parts);
        blobs.set(key, bytes);
        return { sizeBytes: bytes.byteLength };
      },
      async get(key: string) {
        const bytes = blobs.get(key);
        return bytes ? new Response(bytes).body : null;
      },
      async delete(key: string) {
        blobs.delete(key);
      },
    },
    transfer: {
      async download(sandbox: { url: string }) {
        fail('download');
        const text = contents.get(sandbox.url) ?? '';
        return (async function* () {
          yield new TextEncoder().encode(text);
        })();
      },
      async upload(sandbox: { url: string }, body: ReadableStream<Uint8Array>) {
        fail('upload');
        contents.set(sandbox.url, await new Response(body).text());
      },
    },
  };
}

function setup(
  overrides: { probe?: (address: string) => Promise<unknown | null>; archives?: boolean } = {}
) {
  const clock = { now: Date.UTC(2026, 0, 1) };
  const data = createMemoryDataStore();
  const provider = new FakeSandboxProvider(() => clock.now);
  const logs: string[] = [];
  const log = (level: string) => (message: string) => void logs.push(`${level}: ${message}`);
  let ids = 0;
  const fakes = archiveFakes(provider);
  const orchestrator = new Orchestrator({
    ...(overrides.archives
      ? {
          archives: {
            store: () => data.sandboxArchives,
            blobs: fakes.archiveBlobs,
            transfer: fakes.transfer,
          },
        }
      : {}),
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
  return { clock, data, provider, orchestrator, logs, fakes };
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

/** Let a sandbox go idle past the eviction rule: suspended on the way, then swept. */
async function idleForADay(env: ReturnType<typeof setup>) {
  env.clock.now += 16 * MINUTE;
  await env.orchestrator.sweep();
  env.clock.now += 24 * HOUR;
  return env.orchestrator.sweep();
}

describe('a sandbox evicted where archives are kept', () => {
  it('is archived to the blob store before its machine is removed', async () => {
    const env = setup({ archives: true });
    const first = await env.orchestrator.ensure('ann');
    env.fakes.write('m1', 'ann’s checkout');

    expect(await idleForADay(env)).toMatchObject({ removed: 1, archived: 1, failures: 0 });
    expect(env.provider.machines.size).toBe(0);
    const archive = await env.data.sandboxArchives.get('ann');
    expect(archive).toMatchObject({ sandboxId: first.sandboxId, sizeBytes: 16 });
    expect(new TextDecoder().decode(env.fakes.blobs.get(archive!.blobKey))).toBe('ann’s checkout');
    // Resumed to hand its contents over, archived, and only then removed.
    expect(env.provider.calls.slice(-3)).toEqual(['suspend:m1', 'resume:m1', 'destroy:m1']);
  });

  it('comes back with what it held: the next call makes a new machine and unpacks the archive into it first', async () => {
    const env = setup({ archives: true });
    const first = await env.orchestrator.ensure('ann');
    env.fakes.write('m1', 'ann’s checkout');
    await idleForADay(env);

    const second = await env.orchestrator.ensure('ann');
    expect(second.sandboxId).not.toBe(first.sandboxId);
    expect(env.fakes.holdOf('m2')).toBe('ann’s checkout');
  });

  it('gives each scope its own archive: one person’s work never lands in another’s sandbox', async () => {
    const env = setup({ archives: true });
    await env.orchestrator.ensure('ann');
    await env.orchestrator.ensure('bob');
    env.fakes.write('m1', 'ann’s');
    env.fakes.write('m2', 'bob’s');
    await idleForADay(env);

    await env.orchestrator.ensure('bob');
    await env.orchestrator.ensure('ann');
    expect(env.fakes.holdOf('m3')).toBe('bob’s');
    expect(env.fakes.holdOf('m4')).toBe('ann’s');
  });

  it('keeps one archive per scope: the next eviction replaces it and its object', async () => {
    const env = setup({ archives: true });
    await env.orchestrator.ensure('ann');
    env.fakes.write('m1', 'monday');
    await idleForADay(env);
    await env.orchestrator.ensure('ann');
    env.fakes.write('m2', 'tuesday');
    await idleForADay(env);

    expect(env.fakes.blobs.size).toBe(1);
    await env.orchestrator.ensure('ann');
    expect(env.fakes.holdOf('m3')).toBe('tuesday');
  });

  it('is NOT removed when the archive cannot be written: it is put back suspended, and tried again later', async () => {
    const env = setup({ archives: true });
    await env.orchestrator.ensure('ann');
    env.fakes.write('m1', 'ann’s checkout');
    env.fakes.failNext.put = 'the blob store is away';

    expect(await idleForADay(env)).toMatchObject({ removed: 0, archived: 0, failures: 1 });
    expect(env.provider.machines.get('m1')?.state).toBe('suspended');
    expect(await env.data.sandboxes.live('ann')).toMatchObject({
      state: 'suspended',
      error: 'could not be archived: the blob store is away',
    });
    expect(await env.data.sandboxArchives.get('ann')).toBeNull();

    // Not at once: a failed eviction is left a quarter of an hour.
    env.clock.now += 5 * MINUTE;
    expect((await env.orchestrator.sweep()).removed).toBe(0);
    env.clock.now += 11 * MINUTE;
    expect(await env.orchestrator.sweep()).toMatchObject({ removed: 1, archived: 1 });
    expect(env.provider.machines.size).toBe(0);
  });

  it('is not removed when the sandbox will not hand its contents over either', async () => {
    const env = setup({ archives: true });
    await env.orchestrator.ensure('ann');
    env.fakes.failNext.download = 'tar could not pack the sandbox';
    expect(await idleForADay(env)).toMatchObject({ removed: 0, failures: 1 });
    expect(env.provider.machines.size).toBe(1);
  });

  it('is still served while suspended after a failed eviction: a call resumes it with its work in place', async () => {
    const env = setup({ archives: true });
    const first = await env.orchestrator.ensure('ann');
    env.fakes.write('m1', 'ann’s checkout');
    env.fakes.failNext.put = 'the blob store is away';
    await idleForADay(env);

    expect(await env.orchestrator.ensure('ann')).toEqual(first);
    expect(env.fakes.holdOf('m1')).toBe('ann’s checkout');
  });
});

describe('a scope’s archive', () => {
  it('fails the call, and is kept, when it cannot be unpacked: nobody is served an empty sandbox in its place', async () => {
    const env = setup({ archives: true });
    await env.orchestrator.ensure('ann');
    env.fakes.write('m1', 'ann’s checkout');
    await idleForADay(env);

    env.fakes.failNext.upload = 'the archive could not be read';
    await expect(env.orchestrator.ensure('ann')).rejects.toMatchObject({ type: 'provider' });
    expect(env.provider.machines.size).toBe(0);
    expect(await env.data.sandboxArchives.get('ann')).not.toBeNull();

    await env.orchestrator.ensure('ann');
    expect(env.fakes.holdOf('m3')).toBe('ann’s checkout');
  });

  it('whose object is gone from the blob store is forgotten, and the scope starts empty, with a warning', async () => {
    const env = setup({ archives: true });
    await env.orchestrator.ensure('ann');
    await idleForADay(env);
    env.fakes.blobs.clear();

    await env.orchestrator.ensure('ann');
    expect(env.fakes.holdOf('m2')).toBeUndefined();
    expect(await env.data.sandboxArchives.get('ann')).toBeNull();
    expect(env.logs.some((line) => line.startsWith('warn:') && line.includes('archive'))).toBe(
      true
    );
  });

  it('is dropped, object and all, when nobody has come back for it in ninety days', async () => {
    const env = setup({ archives: true });
    await env.orchestrator.ensure('ann');
    await idleForADay(env);
    env.clock.now += 89 * 24 * HOUR;
    expect((await env.orchestrator.sweep()).archivesExpired).toBe(0);
    env.clock.now += 2 * 24 * HOUR;
    expect((await env.orchestrator.sweep()).archivesExpired).toBe(1);
    expect(env.fakes.blobs.size).toBe(0);
    expect(await env.data.sandboxArchives.get('ann')).toBeNull();
  });

  it('goes with the sandbox when the scope’s sandbox is removed on request', async () => {
    const env = setup({ archives: true });
    await env.orchestrator.ensure('ann');
    await idleForADay(env);
    expect(await env.orchestrator.remove('ann')).toBe(true);
    expect(env.fakes.blobs.size).toBe(0);
    await env.orchestrator.ensure('ann');
    expect(env.fakes.holdOf('m2')).toBeUndefined();
  });

  it('is left alone when an eviction is abandoned half way: the sandbox is put back as the provider has it', async () => {
    const env = setup({ archives: true });
    const first = await env.orchestrator.ensure('ann');
    await env.data.sandboxes.transition({
      id: first.sandboxId,
      from: ['running'],
      to: 'archiving',
      at: new Date(env.clock.now),
    });
    env.clock.now += 11 * MINUTE;
    expect((await env.orchestrator.sweep()).recovered).toBe(1);
    expect(env.provider.machines.size).toBe(1);
    expect((await env.data.sandboxes.live('ann'))?.state).toBe('running');
  });
});

describe('what a call to a sandbox carries', () => {
  it('is the sandbox’s key, as the bearer and in its own header', async () => {
    const { orchestrator } = setup();
    const endpoint = await orchestrator.ensure('ann');
    expect(endpoint.headers).toEqual({
      authorization: `Bearer ${endpoint.key}`,
      'x-sandbox-key': endpoint.key,
    });
  });

  it('is the provider’s own token as the bearer where it guards the door, with the key still in its header', async () => {
    const env = setup();
    env.provider.callerHeaders = async () => ({ authorization: 'Bearer entra-token' });
    const endpoint = await env.orchestrator.ensure('ann');
    expect(endpoint.headers).toEqual({
      authorization: 'Bearer entra-token',
      'x-sandbox-key': endpoint.key,
    });
  });

  it('fails the call when the provider cannot give that token', async () => {
    const env = setup();
    env.provider.callerHeaders = async () => {
      throw new Error('no identity');
    };
    await expect(env.orchestrator.ensure('ann')).rejects.toMatchObject({ type: 'provider' });
  });
});

describe('a preview port opened to people’s own browsers', () => {
  it('is not offered where the provider has no such door', async () => {
    const { orchestrator } = setup();
    expect(await orchestrator.expose('code-project:p1', 5173, ['ada@contoso.com'])).toBeNull();
  });

  it('is opened on the scope’s sandbox, made if need be, to the people named', async () => {
    const env = setup();
    const opened: unknown[] = [];
    env.provider.exposePort = async (providerId, port, access) => {
      opened.push([providerId, port, access.emails]);
      return { url: `https://${providerId}-${port}.example` };
    };
    expect(await env.orchestrator.expose('code-project:p1', 5173, ['ada@contoso.com'])).toEqual({
      url: 'https://m1-5173.example',
    });
    expect(opened).toEqual([['m1', 5173, ['ada@contoso.com']]]);
  });

  it('is refused for nobody in particular, for the worker’s own port, and for a port no preview uses', async () => {
    const env = setup();
    env.provider.exposePort = async () => ({ url: 'https://never' });
    const refused = { type: 'bad_request' };
    await expect(env.orchestrator.expose('ann', 5173, [])).rejects.toMatchObject(refused);
    await expect(env.orchestrator.expose('ann', 5173, ['not an email'])).rejects.toMatchObject(
      refused
    );
    await expect(env.orchestrator.expose('ann', 8092, ['a@b.c'])).rejects.toMatchObject(refused);
    await expect(env.orchestrator.expose('ann', 80, ['a@b.c'])).rejects.toMatchObject(refused);
    expect(env.provider.machines.size).toBe(0);
  });
});
