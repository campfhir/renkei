/**
 * The point of the version is that it is DERIVED — a new connector must move
 * it without anyone editing a list. These pin the behaviours the route
 * depends on: the newest timestamp among the rows that shape the surface,
 * a constant when there are none, and a database failure reusing the cache
 * rather than thrashing it.
 */
import { createMemoryDataStore, registerDataStore, resetDataStore } from '@renkei/db';
import { toolSurfaceVersion } from './surface-version';

afterEach(() => {
  resetDataStore();
});

describe('toolSurfaceVersion', () => {
  it('returns the newest timestamp it found', async () => {
    const store = createMemoryDataStore();
    await store.seed({
      settings: [{ key: 'a', value: 1, updated_at: new Date('2026-08-28T23:43:06.647Z') }],
      identities: [
        { subject: 's1', email: 's1@x.test', updated_at: new Date('2026-08-01T00:00:00Z') },
      ],
    });
    registerDataStore(store);
    await expect(toolSurfaceVersion('s1')).resolves.toBe('20260828234306.647000');
  });

  it('moves when one of the caller’s own rows changes, and ignores someone else’s', async () => {
    const store = createMemoryDataStore();
    await store.seed({
      identities: [
        { subject: 's1', email: 's1@x.test', updated_at: new Date('2026-08-01T00:00:00Z') },
        { subject: 's2', email: 's2@x.test', updated_at: new Date('2026-09-01T00:00:00Z') },
      ],
    });
    registerDataStore(store);
    await expect(toolSurfaceVersion('s1')).resolves.toBe('20260801000000.000000');
  });

  it('is a constant when nothing has a timestamp yet', async () => {
    registerDataStore(createMemoryDataStore());
    await expect(toolSurfaceVersion('s1')).resolves.toBe('empty');
  });

  it('returns a CONSTANT on failure, so an outage cannot thrash the cache', async () => {
    const store = createMemoryDataStore();
    registerDataStore({
      ...store,
      toolSurface: {
        version: async () => {
          throw new Error('connection reset');
        },
      },
    });
    // A timestamp here would mint a new key per request and fill the cache
    // with single-use handlers; a constant means "reuse what is cached".
    await expect(toolSurfaceVersion('s1')).resolves.toBe('unknown');
    await expect(toolSurfaceVersion('s1')).resolves.toBe('unknown');
  });
});
