/**
 * Which sandbox instance a caller's calls go to: the one they are
 * assigned to, chosen once and kept; another when theirs has stopped
 * saying it is up; the shared address when no instance has registered.
 */

import {
  createMemoryDataStore,
  registerDataStore,
  resetDataStore,
  type MemoryDataStore,
} from '@renkei/db';
import {
  SANDBOX_INSTANCE_LIVE_MS,
  forgetSandboxEndpoint,
  resetSandboxRoutingForTests,
  sandboxEndpointFor,
  sandboxEndpoints,
} from './routing';

const SHARED = 'http://sandbox.internal:8092';
const T0 = Date.UTC(2026, 0, 1, 12, 0, 0);
const A = 'http://10.0.0.1:8092';
const B = 'http://10.0.0.2:8092';

let store: MemoryDataStore;

async function up(id: string, address: string, at: number): Promise<void> {
  await store.sandboxInstances.heartbeat({
    id,
    address,
    startedAt: new Date(T0 - 3_600_000),
    at: new Date(at),
  });
}

const urlFor = async (subject: string | null, now: number) =>
  (await sandboxEndpointFor(subject, now))?.url;

/** Addresses that do not answer from here, as an instance's address on a network this process is not on. */
let unreachable: string[] = [];

beforeEach(() => {
  unreachable = [];
  jest.spyOn(global, 'fetch').mockImplementation(async (input) => {
    const url = String(input);
    if (unreachable.some((address) => url.startsWith(address))) throw new Error('ECONNREFUSED');
    return new Response('{"ok":true}', { status: 200 });
  });
  process.env.SANDBOX_WORKER_URL = `${SHARED}/`;
  process.env.SANDBOX_WORKER_API_KEY = 'k';
  store = createMemoryDataStore();
  registerDataStore(store);
  resetSandboxRoutingForTests();
});

afterEach(() => {
  jest.restoreAllMocks();
  resetDataStore();
  delete process.env.SANDBOX_WORKER_URL;
  delete process.env.SANDBOX_WORKER_API_KEY;
});

describe('before any instance has registered', () => {
  it('every call goes to the shared address, as it always did', async () => {
    expect(await sandboxEndpointFor('ann', T0)).toEqual({ url: SHARED, key: 'k' });
    expect(await store.sandboxInstances.assignment('ann')).toBeNull();
  });

  it('a sandbox that is not configured has nowhere to send anything', async () => {
    delete process.env.SANDBOX_WORKER_URL;
    expect(await sandboxEndpointFor('ann', T0)).toBeNull();
    expect(await sandboxEndpoints(T0)).toEqual([]);
  });
});

describe('a caller’s instance', () => {
  beforeEach(async () => {
    await up('sandbox-a', A, T0);
    await up('sandbox-b', B, T0);
  });

  it('is chosen on their first call and is the same one on every call after', async () => {
    const first = await urlFor('ann', T0);
    expect([A, B]).toContain(first);
    resetSandboxRoutingForTests();
    expect(await urlFor('ann', T0 + 1_000)).toBe(first);
    resetSandboxRoutingForTests();
    expect(await urlFor('ann', T0 + 20_000)).toBe(first);
  });

  it('is the one serving the fewest callers, so callers spread out', async () => {
    const urls = [
      await urlFor('ann', T0),
      await urlFor('bob', T0),
      await urlFor('code-project:p1', T0),
      await urlFor('code-project:p2', T0),
    ];
    expect(urls.filter((url) => url === A)).toHaveLength(2);
    expect(urls.filter((url) => url === B)).toHaveLength(2);
  });

  it('carries the one key every instance takes', async () => {
    expect((await sandboxEndpointFor('ann', T0))?.key).toBe('k');
  });

  it('a call for no caller goes to the shared address: any instance answers it alike', async () => {
    expect(await urlFor(null, T0)).toBe(SHARED);
  });

  it('two processes deciding at once agree: the second finds the first’s choice', async () => {
    // Another process assigned ann between this one's read and its write.
    const assignment = store.sandboxInstances.assignment.bind(store.sandboxInstances);
    jest.spyOn(store.sandboxInstances, 'assignment').mockImplementationOnce(async (subject) => {
      const seen = await assignment(subject);
      await store.sandboxInstances.assign({
        subject,
        instanceId: 'sandbox-b',
        replacing: null,
        at: new Date(T0),
      });
      return seen;
    });
    expect(await urlFor('ann', T0)).toBe(B);
    expect((await assignment('ann'))?.instanceId).toBe('sandbox-b');
  });
});

describe('an instance that stops saying it is up', () => {
  const later = T0 + SANDBOX_INSTANCE_LIVE_MS + 5_000;

  beforeEach(async () => {
    await up('sandbox-a', A, T0);
    expect(await urlFor('ann', T0)).toBe(A);
    resetSandboxRoutingForTests();
  });

  it('keeps its callers while its heartbeat is merely a little late', async () => {
    await up('sandbox-b', B, T0 + 30_000);
    expect(await urlFor('ann', T0 + SANDBOX_INSTANCE_LIVE_MS - 1_000)).toBe(A);
  });

  it('loses them to an instance that is up, once it has been quiet too long', async () => {
    await up('sandbox-b', B, later);
    expect(await urlFor('ann', later)).toBe(B);
    expect((await store.sandboxInstances.assignment('ann'))?.instanceId).toBe('sandbox-b');
  });

  it('gets them back only by being chosen again: a moved caller stays where they were moved', async () => {
    await up('sandbox-b', B, later);
    expect(await urlFor('ann', later)).toBe(B);
    resetSandboxRoutingForTests();
    await up('sandbox-a', A, later + 1_000);
    expect(await urlFor('ann', later + 1_000)).toBe(B);
  });

  it('keeps them when it comes back under the same name before anyone moved them', async () => {
    // A restart: the same id, perhaps a new address.
    await up('sandbox-a', 'http://10.0.0.7:8092', later);
    expect(await urlFor('ann', later)).toBe('http://10.0.0.7:8092');
  });

  it('with nobody else up, its callers still go to it rather than to an instance that holds nothing of theirs', async () => {
    expect(await urlFor('ann', later)).toBe(A);
  });

  it('a caller whose instance has no row left, and nobody up, falls back to the shared address', async () => {
    await store.sandboxInstances.removeUnseenSince(new Date(later));
    expect(await urlFor('ann', later)).toBe(SHARED);
  });
});

describe('an instance on more networks than this process', () => {
  const DB_NET = 'http://172.30.0.4:8092';

  it('is called at the address that answers from here, whichever it listed first', async () => {
    unreachable = [DB_NET];
    await up('sandbox-a', `${DB_NET},${A}`, T0);
    expect(await urlFor('ann', T0)).toBe(A);
    resetSandboxRoutingForTests();
    await up('sandbox-a', `${A},${DB_NET}`, T0);
    expect(await urlFor('ann', T0)).toBe(A);
  });

  it('is asked which address answers once, not on every call', async () => {
    unreachable = [DB_NET];
    await up('sandbox-a', `${DB_NET},${A}`, T0);
    await urlFor('ann', T0);
    await urlFor('bob', T0);
    await urlFor('ann', T0 + 60_000);
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  it('that cannot be reached from here at all is not given callers: one that can be is', async () => {
    unreachable = [A];
    await up('sandbox-a', A, T0);
    await up('sandbox-b', B, T0);
    expect(await urlFor('ann', T0)).toBe(B);
    expect(await urlFor('bob', T0)).toBe(B);
  });

  it('with no instance reachable from here, calls go to the shared address as they did before', async () => {
    unreachable = [A, B];
    await up('sandbox-a', A, T0);
    await up('sandbox-b', B, T0);
    expect(await urlFor('ann', T0)).toBe(SHARED);
    expect(await store.sandboxInstances.assignment('ann')).toBeNull();
    expect(await sandboxEndpoints(T0)).toEqual([{ url: SHARED, key: 'k' }]);
  });
});

describe('remembering', () => {
  beforeEach(async () => {
    await up('sandbox-a', A, T0);
  });

  it('a caller’s instance is not looked up again for a few seconds', async () => {
    const assignment = jest.spyOn(store.sandboxInstances, 'assignment');
    await urlFor('ann', T0);
    await urlFor('ann', T0 + 2_000);
    expect(assignment).toHaveBeenCalledTimes(1);
    await urlFor('ann', T0 + 11_000);
    expect(assignment).toHaveBeenCalledTimes(2);
  });

  it('a call that did not connect makes the next one look again', async () => {
    const assignment = jest.spyOn(store.sandboxInstances, 'assignment');
    await urlFor('ann', T0);
    forgetSandboxEndpoint('ann');
    await urlFor('ann', T0 + 1_000);
    expect(assignment).toHaveBeenCalledTimes(2);
  });

  it('with no instance registered, the shared address is remembered too', async () => {
    await store.sandboxInstances.removeUnseenSince(new Date(T0 + 1));
    const assignment = jest.spyOn(store.sandboxInstances, 'assignment');
    expect(await urlFor('bob', T0)).toBe(SHARED);
    expect(await urlFor('bob', T0 + 2_000)).toBe(SHARED);
    expect(assignment).toHaveBeenCalledTimes(1);
  });

  it('assignments that cannot be read leave the shared address, not an error', async () => {
    jest.spyOn(store.sandboxInstances, 'assignment').mockRejectedValue(new Error('db is away'));
    expect(await urlFor('ann', T0)).toBe(SHARED);
  });
});

describe('every instance, for a question only one can answer', () => {
  it('is each that is up, or the shared address when none has registered', async () => {
    expect(await sandboxEndpoints(T0)).toEqual([{ url: SHARED, key: 'k' }]);
    await up('sandbox-a', A, T0);
    await up('sandbox-b', `${B}/`, T0);
    await up('sandbox-old', 'http://10.0.0.9:8092', T0 - 10 * 60_000);
    expect(await sandboxEndpoints(T0)).toEqual([
      { url: A, key: 'k' },
      { url: B, key: 'k' },
    ]);
  });
});
