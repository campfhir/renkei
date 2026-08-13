/**
 * TokenBucket's contract: up to `capacity` calls resolve immediately (the
 * allowed burst), the rest queue in FIFO order and are released only as the
 * bucket refills — never all at once, never out of order.
 */

import { TokenBucket } from './index';

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
