/**
 * An instance saying it is up: its row written at once and kept fresh,
 * under a name that outlives a restart, at an address of its own.
 */

import { hostname } from 'node:os';
import {
  createMemoryDataStore,
  registerDataStore,
  resetDataStore,
  type MemoryDataStore,
} from '@renkei/db';
import { advertisedAddress, instanceId, startInstanceHeartbeat } from './instance-registry';

let store: MemoryDataStore;
const ENV = { ...process.env };

beforeEach(() => {
  store = createMemoryDataStore();
  registerDataStore(store);
});

afterEach(() => {
  resetDataStore();
  process.env = { ...ENV };
});

const live = () => store.sandboxInstances.listLive(new Date(Date.now() - 60_000));

describe('the heartbeat', () => {
  it('writes the instance’s row as it starts, and touches it as it runs', async () => {
    const heartbeat = startInstanceHeartbeat({
      id: 'sandbox-a',
      address: 'http://10.0.0.1:8092',
      intervalMs: 3_600_000,
    });
    await heartbeat.beat();
    const [first] = await live();
    expect(first).toMatchObject({ id: 'sandbox-a', address: 'http://10.0.0.1:8092', assigned: 0 });
    await new Promise((resolve) => setTimeout(resolve, 5));
    await heartbeat.beat();
    const [second] = await live();
    expect(second?.lastSeenAt.getTime()).toBeGreaterThan(first?.lastSeenAt.getTime() ?? 0);
    // The same run: its start does not move.
    expect(second?.startedAt).toEqual(first?.startedAt);
    heartbeat.stop();
  });

  it('stopping leaves the row: a restart is back before its callers are moved', async () => {
    const heartbeat = startInstanceHeartbeat({ id: 'sandbox-a', address: 'http://a:1' });
    await heartbeat.beat();
    heartbeat.stop();
    expect(await live()).toHaveLength(1);
  });

  it('a restart under the same name is the same instance, with a new start and perhaps a new address', async () => {
    const before = startInstanceHeartbeat({ id: 'sandbox-a', address: 'http://10.0.0.1:8092' });
    await before.beat();
    before.stop();
    await store.sandboxInstances.assign({
      subject: 'ann',
      instanceId: 'sandbox-a',
      replacing: null,
      at: new Date(),
    });
    const after = startInstanceHeartbeat({ id: 'sandbox-a', address: 'http://10.0.0.5:8092' });
    await after.beat();
    after.stop();
    expect(await live()).toMatchObject([
      { id: 'sandbox-a', address: 'http://10.0.0.5:8092', assigned: 1 },
    ]);
  });

  it('a database that is away does not stop the instance, and it registers when it is back', async () => {
    const failing = jest
      .spyOn(store.sandboxInstances, 'heartbeat')
      .mockRejectedValueOnce(new Error('db is away'));
    const heartbeat = startInstanceHeartbeat({ id: 'sandbox-a', address: 'http://a:1' });
    await heartbeat.beat();
    failing.mockRestore();
    await heartbeat.beat();
    heartbeat.stop();
    expect(await live()).toHaveLength(1);
  });

  it('clears rows nobody has touched for a day as it goes', async () => {
    await store.sandboxInstances.heartbeat({
      id: 'long-gone',
      address: 'http://old:1',
      startedAt: new Date(Date.now() - 3 * 86_400_000),
      at: new Date(Date.now() - 2 * 86_400_000),
    });
    const heartbeat = startInstanceHeartbeat({ id: 'sandbox-a', address: 'http://a:1' });
    await heartbeat.beat();
    heartbeat.stop();
    expect((await store.sandboxInstances.listLive(new Date(0))).map((row) => row.id)).toEqual([
      'sandbox-a',
    ]);
  });
});

describe('its name and address', () => {
  it('the name is SANDBOX_INSTANCE_ID when set, else the hostname', () => {
    delete process.env.SANDBOX_INSTANCE_ID;
    expect(instanceId()).toBe(hostname());
    process.env.SANDBOX_INSTANCE_ID = ' sandbox-0 ';
    expect(instanceId()).toBe('sandbox-0');
  });

  it('the address is the one configured, else this machine’s own on the listening port', () => {
    delete process.env.SANDBOX_WORKER_ADVERTISE_URL;
    expect(advertisedAddress(8092)).toMatch(/^http:\/\/\d+\.\d+\.\d+\.\d+:8092$/);
    process.env.SANDBOX_WORKER_ADVERTISE_URL = 'http://sandbox-0.sandbox:8092/';
    expect(advertisedAddress(8092)).toBe('http://sandbox-0.sandbox:8092');
  });
});
