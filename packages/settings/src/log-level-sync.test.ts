/**
 * getEffectiveLogLevel's contract: the organization's configured level,
 * info until one is configured, null when there is nothing to apply (the
 * database is unreachable); watchLogLevel applies that level to every
 * adapter with a `level` property and leaves the rest alone.
 */

import { createMemoryDataStore, registerDataStore, resetDataStore } from '@renkei/db';
import { getEffectiveLogLevel, watchLogLevel } from './log-level-sync';
import { invalidateSettingsCache } from './index';

/** The one organization's settings, on a memory store, with this log level stored. */
function stubStore(level?: string): void {
  const store = createMemoryDataStore();
  if (level !== undefined) void store.settings.set('log_level', level);
  registerDataStore(store);
}

/** A store whose every read fails, as an unreachable database does. */
function unreachableStore(): void {
  const store = createMemoryDataStore();
  registerDataStore({
    ...store,
    settings: { ...store.settings, all: () => Promise.reject(new Error('DB_INIT_ERROR')) },
  });
}

beforeEach(() => {
  invalidateSettingsCache();
});

afterAll(() => {
  resetDataStore();
});

describe('getEffectiveLogLevel', () => {
  it('returns null when the database is unavailable', async () => {
    unreachableStore();
    expect(await getEffectiveLogLevel()).toBeNull();
  });

  it('defaults to info when no level has been configured', async () => {
    stubStore();
    expect(await getEffectiveLogLevel()).toBe('info');
  });

  it('returns the configured level', async () => {
    stubStore('debug');
    expect(await getEffectiveLogLevel()).toBe('debug');
  });

  it('ignores a value that is not a level', async () => {
    stubStore('loud');
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
    stubStore('debug');
    const consoleAdapter = { level: 'info' };
    const noLevelAdapter = {};
    const logger = { adapters: [consoleAdapter, noLevelAdapter] };

    const stop = watchLogLevel(logger, 999_999);
    await jest.advanceTimersByTimeAsync(0);

    expect(consoleAdapter.level).toBe('debug');
    stop();
  });

  it('leaves the current level alone when the database is unavailable', async () => {
    unreachableStore();
    const adapter = { level: 'info' };
    const logger = { adapters: [adapter] };

    const stop = watchLogLevel(logger, 999_999);
    await jest.advanceTimersByTimeAsync(0);

    expect(adapter.level).toBe('info');
    stop();
  });

  it('re-applies on every poll, picking up an adapter registered after the first tick', async () => {
    stubStore('warn');
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
