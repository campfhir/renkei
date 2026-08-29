/* eslint-disable @typescript-eslint/consistent-type-assertions */
/**
 * The point of the version is that it is DERIVED — a new connector must move
 * it without anyone editing a list. These pin the two behaviours the route
 * depends on: the query reads every table that shapes the surface, and a
 * database failure reuses the cache rather than thrashing it.
 */
import { toolSurfaceVersion } from './surface-version';

type Db = Parameters<typeof toolSurfaceVersion>[0];

function stubDb(execute: () => Promise<{ rows: { version: string | null }[] }>): Db {
  // sql`…`.execute(db) reaches the driver through the db object; capturing
  // the compiled query is enough for what these assert.
  return {
    getExecutor: () => ({
      executeQuery: execute,
      compileQuery: (node: unknown) => node,
      provideConnection: async (fn: (c: unknown) => unknown) => fn({ executeQuery: execute }),
      adapter: { supportsReturning: true },
      transformQuery: (node: unknown) => node,
    }),
  } as unknown as Db;
}

describe('toolSurfaceVersion', () => {
  it('returns the newest timestamp it found', async () => {
    const db = stubDb(async () => ({ rows: [{ version: '20260828234306.647000' }] }));
    await expect(toolSurfaceVersion(db, 't1', 's1')).resolves.toBe('20260828234306.647000');
  });

  it('is a constant when nothing has a timestamp yet', async () => {
    const db = stubDb(async () => ({ rows: [{ version: null }] }));
    await expect(toolSurfaceVersion(db, 't1', 's1')).resolves.toBe('empty');
  });

  it('returns a CONSTANT on failure, so an outage cannot thrash the cache', async () => {
    const db = stubDb(async () => {
      throw new Error('connection reset');
    });
    // A timestamp here would mint a new key per request and fill the cache
    // with single-use handlers; a constant means "reuse what is cached".
    await expect(toolSurfaceVersion(db, 't1', 's1')).resolves.toBe('unknown');
    await expect(toolSurfaceVersion(db, 't1', 's1')).resolves.toBe('unknown');
  });
});
