/**
 * getEffectiveLogLevel's contract: the most verbose level any tenant has
 * configured wins (never the average, never the first), null when there is
 * nothing to apply; watchLogLevel applies that level to every adapter with
 * a `level` property and leaves the rest alone.
 */

jest.mock('@renkei/db', () => ({ getDatabase: jest.fn() }));

import { getEffectiveLogLevel, watchLogLevel } from './log-level-sync';
import { invalidateSettingsCache } from './index';

const { getDatabase: mockGetDatabase } = jest.requireMock<{ getDatabase: jest.Mock }>('@renkei/db');

/** Stubs both `tenants` (a plain id list) and `tenant_settings` (log_level per tenant). */
function stubDb(tenantIds: string[], levels: Record<string, string> = {}): void {
  const settingsRows = new Map<string, unknown>();
  for (const [tenantId, level] of Object.entries(levels)) {
    settingsRows.set(`${tenantId}:log_level`, level);
  }

  mockGetDatabase.mockReturnValue({
    ok: true,
    val: {
      selectFrom: (table: string) => {
        if (table === 'tenants') {
          return { select: () => ({ execute: async () => tenantIds.map((id) => ({ id })) }) };
        }
        const filters: Record<string, unknown> = {};
        const chain = {
          select: () => chain,
          where: (column: string, _op: string, value: unknown) => {
            filters[column] = value;
            return chain;
          },
          execute: async () => {
            const tenantId = String(filters.tenant_id);
            return [...settingsRows.entries()]
              .filter(([key]) => key.startsWith(`${tenantId}:`))
              .map(([key, value]) => ({ key: key.split(':')[1], value }));
          },
        };
        return chain;
      },
    },
  });
}

beforeEach(() => {
  mockGetDatabase.mockReset();
  invalidateSettingsCache();
});

describe('getEffectiveLogLevel', () => {
  it('returns null when the database is unavailable', async () => {
    mockGetDatabase.mockReturnValue({ ok: false, err: 'DB_INIT_ERROR' });
    expect(await getEffectiveLogLevel()).toBeNull();
  });

  it('returns null when there are no tenants yet', async () => {
    stubDb([]);
    expect(await getEffectiveLogLevel()).toBeNull();
  });

  it('defaults to info when no tenant has configured a level', async () => {
    stubDb(['t1', 't2']);
    expect(await getEffectiveLogLevel()).toBe('info');
  });

  it('picks the most verbose level across tenants, not the first or the average', async () => {
    stubDb(['t1', 't2', 't3'], { t1: 'error', t2: 'debug', t3: 'warn' });
    expect(await getEffectiveLogLevel()).toBe('debug');
  });

  it('a stricter tenant never suppresses a more verbose one', async () => {
    stubDb(['t1', 't2'], { t1: 'critical', t2: 'warn' });
    expect(await getEffectiveLogLevel()).toBe('warn');
  });
});

describe('watchLogLevel', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('applies the effective level immediately to every adapter with a level property', async () => {
    stubDb(['t1'], { t1: 'debug' });
    const consoleAdapter = { level: 'info' };
    const noLevelAdapter = {};
    const logger = { adapters: [consoleAdapter, noLevelAdapter] };

    const stop = watchLogLevel(logger, 999_999);
    await jest.advanceTimersByTimeAsync(0);

    expect(consoleAdapter.level).toBe('debug');
    stop();
  });

  it('leaves the current level alone when the database is unavailable', async () => {
    mockGetDatabase.mockReturnValue({ ok: false, err: 'DB_INIT_ERROR' });
    const adapter = { level: 'info' };
    const logger = { adapters: [adapter] };

    const stop = watchLogLevel(logger, 999_999);
    await jest.advanceTimersByTimeAsync(0);

    expect(adapter.level).toBe('info');
    stop();
  });

  it('re-applies on every poll, picking up an adapter registered after the first tick', async () => {
    stubDb(['t1'], { t1: 'warn' });
    const logger: { adapters: unknown[] } = { adapters: [] };

    const stop = watchLogLevel(logger, 1_000);
    await jest.advanceTimersByTimeAsync(0);

    const lateAdapter = { level: 'info' };
    logger.adapters.push(lateAdapter);
    await jest.advanceTimersByTimeAsync(1_000);

    expect(lateAdapter.level).toBe('warn');
    stop();
  });
});
