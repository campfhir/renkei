/**
 * The single-runner election. What must hold: an acquired lock runs the
 * sweep and always unlocks (even when the sweep throws), a lost lock skips
 * the sweep entirely, and everything happens on the ONE pinned connection —
 * an advisory lock released through a different pool connection would not
 * release anything.
 */

const executeMock = jest.fn();
jest.mock('kysely', () => ({
  sql: jest.fn(() => ({ execute: executeMock })),
}));
jest.mock('@renkei/db', () => ({ getDatabase: jest.fn() }));
jest.mock('../logger', () => ({
  logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

import { withSweepLock } from './sweep-lock';

const { getDatabase: mockGetDatabase } = jest.requireMock<{ getDatabase: jest.Mock }>('@renkei/db');

/** A db whose connection() pins one recorded connection object. */
function stubDb(): { connection: unknown } {
  const conn = { pinned: true };
  const db = {
    connection: () => ({
      execute: (callback: (c: unknown) => Promise<void>) => callback(conn),
    }),
  };
  mockGetDatabase.mockReturnValue({ ok: true, val: db });
  return { connection: conn };
}

beforeEach(() => {
  executeMock.mockReset();
  mockGetDatabase.mockReset();
});

it('runs the sweep and unlocks when the lock is acquired', async () => {
  const { connection } = stubDb();
  executeMock
    .mockResolvedValueOnce({ rows: [{ locked: true }] }) // pg_try_advisory_lock
    .mockResolvedValueOnce({ rows: [] }); // pg_advisory_unlock
  const sweep = jest.fn(async () => undefined);

  await withSweepLock('webex-webhooks', sweep)();

  expect(sweep).toHaveBeenCalledTimes(1);
  expect(executeMock).toHaveBeenCalledTimes(2);
  // Both the lock and the unlock ran on the same pinned connection.
  expect(executeMock).toHaveBeenNthCalledWith(1, connection);
  expect(executeMock).toHaveBeenNthCalledWith(2, connection);
});

it('unlocks even when the sweep throws', async () => {
  stubDb();
  executeMock
    .mockResolvedValueOnce({ rows: [{ locked: true }] })
    .mockResolvedValueOnce({ rows: [] });
  const sweep = jest.fn(async () => {
    throw new Error('provider exploded');
  });

  await expect(withSweepLock('webex-webhooks', sweep)()).rejects.toThrow('provider exploded');

  expect(executeMock).toHaveBeenCalledTimes(2); // lock + unlock, despite the throw
});

it('skips the sweep entirely when another worker holds the lock', async () => {
  stubDb();
  executeMock.mockResolvedValueOnce({ rows: [{ locked: false }] });
  const sweep = jest.fn(async () => undefined);

  await withSweepLock('webex-webhooks', sweep)();

  expect(sweep).not.toHaveBeenCalled();
  expect(executeMock).toHaveBeenCalledTimes(1); // no unlock for a lock never held
});

it('skips when the database is unavailable', async () => {
  mockGetDatabase.mockReturnValue({ ok: false, err: 'down' });
  const sweep = jest.fn(async () => undefined);

  await withSweepLock('webex-webhooks', sweep)();

  expect(sweep).not.toHaveBeenCalled();
  expect(executeMock).not.toHaveBeenCalled();
});
