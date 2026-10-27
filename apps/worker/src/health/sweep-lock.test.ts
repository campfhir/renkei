/**
 * The single-runner election. What must hold: an acquired lock runs the
 * sweep and always releases (even when the sweep throws), a held lock
 * skips the sweep entirely, and a lock that cannot be taken at all skips
 * the pass rather than failing it. Runs on the memory store, whose
 * advisory lock is an in-process set; the Postgres lock's own behaviour is
 * the differential suite's (packages/db advisory-locks scenarios).
 */

import { createMemoryDataStore, registerDataStore, resetDataStore } from '@renkei/db';
import { withSweepLock } from './sweep-lock';

beforeEach(() => {
  registerDataStore(createMemoryDataStore());
});

afterEach(() => {
  resetDataStore();
});

it('runs the sweep, and releases the lock for the next pass', async () => {
  const sweep = jest.fn(async () => undefined);
  const locked = withSweepLock('webex-webhooks', sweep);

  await locked();
  await locked();

  expect(sweep).toHaveBeenCalledTimes(2);
});

it('releases even when the sweep throws, and passes the throw on', async () => {
  const sweep = jest
    .fn<Promise<void>, []>()
    .mockRejectedValueOnce(new Error('provider exploded'))
    .mockResolvedValueOnce(undefined);
  const locked = withSweepLock('webex-webhooks', sweep);

  await expect(locked()).rejects.toThrow('provider exploded');
  await locked();

  expect(sweep).toHaveBeenCalledTimes(2); // the second pass got the lock back
});

it('skips the sweep entirely while another runner holds the lock', async () => {
  const inner = jest.fn(async () => undefined);
  const other = jest.fn(async () => undefined);
  const outer = withSweepLock('webex-webhooks', async () => {
    await withSweepLock('webex-webhooks', inner)();
    await withSweepLock('content-watches', other)();
  });

  await outer();

  expect(inner).not.toHaveBeenCalled();
  expect(other).toHaveBeenCalledTimes(1); // a different sweep is its own lock
});

it('skips when the lock cannot be taken at all', async () => {
  const store = createMemoryDataStore();
  registerDataStore({
    ...store,
    advisoryLocks: {
      withTryLock: async () => {
        throw new Error('database unavailable');
      },
    },
  });
  const sweep = jest.fn(async () => undefined);

  await expect(withSweepLock('webex-webhooks', sweep)()).resolves.toBeUndefined();

  expect(sweep).not.toHaveBeenCalled();
});
