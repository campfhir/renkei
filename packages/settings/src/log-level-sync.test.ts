/**
 * getEffectiveLogLevel's contract: the organization's configured level,
 * info until one is configured, null when there is nothing to apply (the
 * database is unreachable); watchLogLevel applies that level to every
 * adapter with a `level` property and leaves the rest alone.
 */

jest.mock('@renkei/db', () => ({ getDatabase: jest.fn() }));

import { getEffectiveLogLevel, watchLogLevel } from './log-level-sync';
import { invalidateSettingsCache } from './index';

const { getDatabase: mockGetDatabase } = jest.requireMock<{ getDatabase: jest.Mock }>('@renkei/db');

/** Stubs the `settings` table: the one organization's rows by key. */
function stubDb(level?: string): void {
  const settingsRows = level === undefined ? [] : [{ key: 'log_level', value: level }];

  mockGetDatabase.mockReturnValue({
    ok: true,
    val: {
      selectFrom: () => {
        const chain = {
          select: () => chain,
          where: () => chain,
          execute: async () => settingsRows,
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

  it('defaults to info when no level has been configured', async () => {
    stubDb();
    expect(await getEffectiveLogLevel()).toBe('info');
  });

  it('returns the configured level', async () => {
    stubDb('debug');
    expect(await getEffectiveLogLevel()).toBe('debug');
  });

  it('ignores a value that is not a level', async () => {
    stubDb('loud');
    expect(await getEffectiveLogLevel()).toBe('info');
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
    stubDb('debug');
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
    stubDb('warn');
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
