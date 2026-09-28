/**
 * The shutdown hook: every subscriber hears it once, a late subscriber
 * hears it at once, the wait is bounded, and a second signal is nothing.
 */

import { beginShutdown, isShuttingDown, onShutdown, resetShutdownForTests } from './shutdown';

beforeEach(() => {
  resetShutdownForTests();
});

describe('shutdown', () => {
  it('tells every subscriber once and waits for them', async () => {
    const seen: string[] = [];
    onShutdown(() => {
      seen.push('a');
    });
    onShutdown(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      seen.push('b');
    });
    expect(isShuttingDown()).toBe(false);
    await beginShutdown(1_000);
    expect(isShuttingDown()).toBe(true);
    expect(seen.sort()).toEqual(['a', 'b']);
    await beginShutdown(1_000);
    expect(seen.length).toBe(2);
  });

  it('runs a subscriber registered after the fact at once, and honours an unsubscribe', async () => {
    let late = 0;
    let gone = 0;
    const unsubscribe = onShutdown(() => {
      gone += 1;
    });
    unsubscribe();
    await beginShutdown(1_000);
    onShutdown(() => {
      late += 1;
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(late).toBe(1);
    expect(gone).toBe(0);
  });

  it('does not wait past the bound for a subscriber that never settles, nor fail on one that throws', async () => {
    onShutdown(() => new Promise<void>(() => {}));
    onShutdown(() => {
      throw new Error('boom');
    });
    const started = Date.now();
    await beginShutdown(50);
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(isShuttingDown()).toBe(true);
  });
});
