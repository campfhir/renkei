/* eslint-disable @typescript-eslint/consistent-type-assertions -- stand-ins for the db and server rows */
import type { Kysely } from 'kysely';
import type { DB } from '@renkei/db';
import type { McpServer } from '@renkei/connector-mcp';

const watchToolListChanges = jest.fn();
const getServer = jest.fn();
const refreshToolList = jest.fn();

jest.mock('@renkei/connector-mcp', () => ({
  McpAuthRequired: class McpAuthRequired extends Error {},
  getServer: (...args: unknown[]) => getServer(...args),
  watchToolListChanges: (...args: unknown[]) => watchToolListChanges(...args),
}));
jest.mock('./remote', () => ({
  mcpFetchFor: () => jest.fn(),
  refreshToolList: (...args: unknown[]) => refreshToolList(...args),
}));
jest.mock('@/lib/logger', () => ({ logger: { warn: jest.fn(), debug: jest.fn() } }));

import { ensureWatching, resetWatches, stopWatching } from './watch';

const db = {} as Kysely<DB>;
const server = {
  id: 's1',
  slug: 'acme',
  url: 'https://m.example/mcp',
  transport: 'streamable_http',
  enabled: true,
} as McpServer;

/** Let the watch loop run to its next await. */
const settle = () => new Promise((resolve) => setImmediate(resolve));

beforeEach(() => {
  resetWatches();
  watchToolListChanges.mockReset();
  getServer.mockReset().mockResolvedValue({ ok: true, val: server });
  refreshToolList.mockReset().mockResolvedValue({ ok: true, tools: [] });
});
afterAll(() => resetWatches());

describe('ensureWatching', () => {
  it('opens one watch per person and server, however often it is asked', async () => {
    watchToolListChanges.mockReturnValue(new Promise(() => undefined));
    ensureWatching(db, server, 'u1');
    ensureWatching(db, server, 'u1');
    ensureWatching(db, server, 'u2');
    await settle();
    expect(watchToolListChanges).toHaveBeenCalledTimes(2);
  });

  it('refreshes the person’s list when the server announces a change', async () => {
    watchToolListChanges.mockImplementation(async (options: { onChange: () => void }) => {
      options.onChange();
      return new Promise(() => undefined);
    });
    ensureWatching(db, server, 'u1');
    await settle();
    expect(refreshToolList).toHaveBeenCalledWith(db, server, 'u1');
  });

  it('does not watch a server that does not announce changes, and does not ask again', async () => {
    watchToolListChanges.mockResolvedValue('unsupported');
    ensureWatching(db, server, 'u1');
    await settle();
    ensureWatching(db, server, 'u2');
    await settle();
    expect(watchToolListChanges).toHaveBeenCalledTimes(1);
  });

  it('lets go when the server was disabled, and when the person disconnects', async () => {
    getServer.mockResolvedValue({ ok: true, val: { ...server, enabled: false } });
    ensureWatching(db, server, 'u1');
    await settle();
    expect(watchToolListChanges).not.toHaveBeenCalled();

    getServer.mockResolvedValue({ ok: true, val: server });
    let signal: AbortSignal | undefined;
    watchToolListChanges.mockImplementation(async (options: { signal: AbortSignal }) => {
      signal = options.signal;
      return new Promise(() => undefined);
    });
    ensureWatching(db, server, 'u1');
    await settle();
    stopWatching('s1', 'u1');
    expect(signal?.aborted).toBe(true);
  });
});
