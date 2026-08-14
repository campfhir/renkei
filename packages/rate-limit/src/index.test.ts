/**
 * TokenBucket's contract: up to `capacity` calls resolve immediately (the
 * allowed burst), the rest queue in FIFO order and are released only as the
 * bucket refills — never all at once, never out of order.
 */

import { TokenBucket, LaneLimiter } from './index';

beforeEach(() => {
  jest.useFakeTimers();
});

afterEach(() => {
  jest.useRealTimers();
});

describe('TokenBucket', () => {
  it('lets a burst up to capacity through immediately', async () => {
    const bucket = new TokenBucket({ capacity: 5, refillPerSecond: 5 });
    const resolved: number[] = [];

    for (let i = 0; i < 5; i++) {
      void bucket.take().then(() => resolved.push(i));
    }
    await Promise.resolve(); // let the microtask queue drain
    await Promise.resolve();

    expect(resolved).toEqual([0, 1, 2, 3, 4]);
  });

  it('queues calls beyond capacity and releases them only as tokens refill', async () => {
    const bucket = new TokenBucket({ capacity: 5, refillPerSecond: 5 });
    const resolved: number[] = [];
    for (let i = 0; i < 20; i++) {
      void bucket.take().then(() => resolved.push(i));
    }
    await Promise.resolve();
    await Promise.resolve();

    // The burst of 5 went through; the other 15 are still queued.
    expect(resolved).toEqual([0, 1, 2, 3, 4]);

    // 5 tokens/sec → roughly one release every 200ms. Advance a full second
    // and only ~5 more (not all 15) should have been released.
    await jest.advanceTimersByTimeAsync(1000);
    expect(resolved.length).toBeGreaterThanOrEqual(9);
    expect(resolved.length).toBeLessThan(20);

    // The rest trickle out over the remaining time, in the order requested.
    await jest.advanceTimersByTimeAsync(3000);
    expect(resolved).toEqual(Array.from({ length: 20 }, (_, i) => i));
  });

  it('refills up to capacity but never beyond it', async () => {
    const bucket = new TokenBucket({ capacity: 3, refillPerSecond: 100 });
    await jest.advanceTimersByTimeAsync(10_000);
    expect(bucket.available()).toBe(3);
  });
});

describe('LaneLimiter', () => {
  it('does not let a saturated background lane delay interactive work', async () => {
    // The whole reason the class exists: a webhook flood used to drain the
    // one shared bucket, an ACL check queued behind it, and the retrieval
    // gate withheld results the user was allowed to see.
    const limiter = new LaneLimiter({
      interactive: { capacity: 2, refillPerSecond: 1 },
      background: { capacity: 1, refillPerSecond: 1 },
    });
    const resolved: string[] = [];

    // Drain background, then pile more behind it.
    void limiter.take('background').then(() => resolved.push('bg-0'));
    void limiter.take('background').then(() => resolved.push('bg-1'));
    void limiter.take('background').then(() => resolved.push('bg-2'));
    void limiter.take('interactive').then(() => resolved.push('interactive'));

    await Promise.resolve();
    await Promise.resolve();

    // The interactive call went straight through; two background calls are
    // still queued behind their own lane's refill.
    expect(resolved).toContain('interactive');
    expect(resolved).not.toContain('bg-1');
  });

  it('still throttles within a lane once its own burst is spent', async () => {
    const limiter = new LaneLimiter({
      interactive: { capacity: 1, refillPerSecond: 1 },
      background: { capacity: 1, refillPerSecond: 1 },
    });
    const resolved: number[] = [];

    void limiter.take('interactive').then(() => resolved.push(0));
    void limiter.take('interactive').then(() => resolved.push(1));
    await Promise.resolve();
    await Promise.resolve();

    // A separate lane is not a free pass — the burst is still capacity 1.
    expect(resolved).toEqual([0]);

    await jest.advanceTimersByTimeAsync(1000);
    expect(resolved).toEqual([0, 1]);
  });

  it('treats an unspecified lane as background', async () => {
    // The conservative default: code that has not thought about lanes is not
    // the code a person is waiting on.
    const limiter = new LaneLimiter({
      interactive: { capacity: 1, refillPerSecond: 1 },
      background: { capacity: 1, refillPerSecond: 1 },
    });
    const resolved: string[] = [];

    void limiter.take().then(() => resolved.push('default-1'));
    void limiter.take().then(() => resolved.push('default-2'));
    void limiter.take('interactive').then(() => resolved.push('interactive'));
    await Promise.resolve();
    await Promise.resolve();

    // Both defaults competed for the background token, so the second queued
    // while the untouched interactive lane let its call straight through.
    expect(resolved).toEqual(['default-1', 'interactive']);
  });
});
