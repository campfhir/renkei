/**
 * The retry helper's contract, exercised against real timers: the delays it
 * actually waits are the point, so the backoff suites take seconds rather
 * than fake-timer ticks — a mocked clock would prove the arithmetic and
 * nothing about the waiting.
 */

import { getEventListeners } from 'node:events';
import { retryWithBackoff, RetryExhaustedError, OperationAbortedError } from './retry-with-backoff';

/** Settle a rejection into a value so the assertion can inspect it. */
async function rejection(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error('expected the operation to reject, but it resolved');
    },
    (error: unknown) => error
  );
}

describe('retryWithBackoff', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('successful execution', () => {
    it('succeeds on first attempt', async () => {
      const fn = jest.fn().mockResolvedValue('success');
      const result = await retryWithBackoff(fn);
      expect(result).toBe('success');
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it('succeeds after one retry', async () => {
      const fn = jest.fn();
      fn.mockRejectedValueOnce(new Error('fail'));
      fn.mockResolvedValueOnce('success');

      const result = await retryWithBackoff(fn, { timeout: 5000, maxRetries: 2 });
      expect(result).toBe('success');
      expect(fn).toHaveBeenCalledTimes(2);
    });

    it('succeeds after multiple retries', async () => {
      const fn = jest.fn();
      fn.mockRejectedValueOnce(new Error('fail 1'));
      fn.mockRejectedValueOnce(new Error('fail 2'));
      fn.mockResolvedValueOnce('success');

      const result = await retryWithBackoff(fn, { timeout: 5000, maxRetries: 3 });
      expect(result).toBe('success');
      expect(fn).toHaveBeenCalledTimes(3);
    });
  });

  describe('exponential backoff', () => {
    // Really waits 1s + 2s + 4s; the default 5s timeout would cut it short.
    it('uses exponential delays: 1s, 2s, 4s', async () => {
      const fn = jest.fn().mockRejectedValue(new Error('fail'));
      const delays: number[] = [];

      await rejection(
        retryWithBackoff(fn, {
          timeout: 10000,
          maxRetries: 3,
          backoffStrategy: 'exponential',
          backoffOffset: 1000,
          onRetry: (attempt, error, delay) => {
            delays.push(delay);
          },
        })
      );

      // Exponential: 1s (2^0), 2s (2^1), 4s (2^2)
      expect(delays).toEqual([1000, 2000, 4000]);
    }, 15000);

    it('respects custom backoff offset', async () => {
      const fn = jest.fn().mockRejectedValue(new Error('fail'));
      const delays: number[] = [];

      await rejection(
        retryWithBackoff(fn, {
          timeout: 10000,
          maxRetries: 2,
          backoffStrategy: 'exponential',
          backoffOffset: 500, // 0.5s base
          onRetry: (attempt, error, delay) => {
            delays.push(delay);
          },
        })
      );

      // Exponential with 500ms offset: 500ms (2^0), 1000ms (2^1)
      expect(delays).toEqual([500, 1000]);
    });
  });

  describe('linear backoff', () => {
    // Really waits 1s + 2s + 3s; see the exponential note above.
    it('uses linear delays: 1s, 2s, 3s', async () => {
      const fn = jest.fn().mockRejectedValue(new Error('fail'));
      const delays: number[] = [];

      await rejection(
        retryWithBackoff(fn, {
          timeout: 10000,
          maxRetries: 3,
          backoffStrategy: 'linear',
          backoffOffset: 1000,
          onRetry: (attempt, error, delay) => {
            delays.push(delay);
          },
        })
      );

      // Linear: 1s (1*1), 2s (2*1), 3s (3*1)
      expect(delays).toEqual([1000, 2000, 3000]);
    }, 15000);

    it('respects custom backoff offset for linear', async () => {
      const fn = jest.fn().mockRejectedValue(new Error('fail'));
      const delays: number[] = [];

      await rejection(
        retryWithBackoff(fn, {
          timeout: 10000,
          maxRetries: 2,
          backoffStrategy: 'linear',
          backoffOffset: 500,
          onRetry: (attempt, error, delay) => {
            delays.push(delay);
          },
        })
      );

      // Linear with 500ms offset: 500ms (1*500), 1000ms (2*500)
      expect(delays).toEqual([500, 1000]);
    });
  });

  describe('timeout behavior', () => {
    it('throws RetryExhaustedError when timeout is exceeded', async () => {
      const fn = jest.fn().mockRejectedValue(new Error('fail'));

      await expect(
        retryWithBackoff(fn, {
          timeout: 100,
          maxRetries: 5,
          backoffOffset: 500, // Delays would be huge
        })
      ).rejects.toThrow(RetryExhaustedError);
    });

    it('includes last error in RetryExhaustedError', async () => {
      const originalError = new Error('original fail');
      const fn = jest.fn().mockRejectedValue(originalError);

      const caught = await rejection(
        retryWithBackoff(fn, {
          timeout: 100,
          maxRetries: 5,
          backoffOffset: 500,
        })
      );

      expect(caught).toBeInstanceOf(RetryExhaustedError);
      if (!(caught instanceof RetryExhaustedError)) return;
      expect(caught.lastError).toBe(originalError);
    });

    it('respects custom timeout', async () => {
      const fn = jest.fn().mockRejectedValue(new Error('fail'));
      const startTime = Date.now();

      await expect(
        retryWithBackoff(fn, {
          timeout: 500,
          maxRetries: 10,
          backoffOffset: 100,
        })
      ).rejects.toThrow(RetryExhaustedError);

      const elapsed = Date.now() - startTime;
      // Should be close to 500ms (allow 200ms variance)
      expect(elapsed).toBeGreaterThan(300);
      expect(elapsed).toBeLessThan(900);
    });
  });

  describe('abort signal', () => {
    it('throws OperationAbortedError when signal is already aborted', async () => {
      const controller = new AbortController();
      controller.abort();

      const fn = jest.fn();

      await expect(retryWithBackoff(fn, { signal: controller.signal })).rejects.toThrow(
        OperationAbortedError
      );

      expect(fn).not.toHaveBeenCalled();
    });

    it('aborts during backoff delay', async () => {
      const controller = new AbortController();
      const fn = jest.fn().mockRejectedValue(new Error('fail'));

      // Start the operation and abort after a short delay
      const promise = retryWithBackoff(fn, {
        timeout: 10000,
        maxRetries: 5,
        backoffOffset: 1000,
        signal: controller.signal,
      });

      setTimeout(() => controller.abort(), 100);

      await expect(promise).rejects.toThrow(OperationAbortedError);

      // Should have attempted once, then been interrupted during first backoff
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it('aborts while an attempt is still running, without waiting it out', async () => {
      const controller = new AbortController();
      // Resolves far later than the abort: if the abort were only noticed
      // between attempts, this would take the full second.
      let settle: ReturnType<typeof setTimeout> | undefined;
      const fn = jest.fn(
        () =>
          new Promise((resolve) => {
            settle = setTimeout(() => resolve('success'), 1000);
          })
      );

      const promise = retryWithBackoff(fn, {
        timeout: 10000,
        maxRetries: 5,
        signal: controller.signal,
      });

      const startTime = Date.now();
      setTimeout(() => controller.abort(), 50);

      await expect(promise).rejects.toThrow(OperationAbortedError);

      // Rejected on the abort, not on the operation's own completion.
      expect(Date.now() - startTime).toBeLessThan(500);
      if (settle) clearTimeout(settle);
    });

    it('leaves no pending timer behind on success', async () => {
      // A Promise.race against an uncleared timeout timer keeps the event
      // loop alive for the full attempt cap (60s) after the call already
      // returned — on every successful call, not just failures.
      jest.useFakeTimers();
      try {
        const fn = jest.fn().mockResolvedValue('success');
        await retryWithBackoff(fn, { timeout: 180_000 });

        expect(jest.getTimerCount()).toBe(0);
      } finally {
        jest.useRealTimers();
      }
    });

    it('removes its abort listener once an attempt settles', async () => {
      // A listener left on a caller-owned signal accumulates across calls
      // and trips Node's max-listeners warning.
      const controller = new AbortController();
      const fn = jest.fn().mockResolvedValue('success');

      for (let i = 0; i < 20; i++) {
        await retryWithBackoff(fn, { timeout: 5000, signal: controller.signal });
      }

      // AbortSignal is an EventTarget, which exposes no listener count of
      // its own — node:events can see through it.
      expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
    });
  });

  describe('onRetry callback', () => {
    it('calls onRetry with attempt number, error, and delay', async () => {
      const fn = jest.fn();
      fn.mockRejectedValueOnce(new Error('fail 1'));
      fn.mockRejectedValueOnce(new Error('fail 2'));
      fn.mockResolvedValueOnce('success');

      const onRetry = jest.fn();

      await retryWithBackoff(fn, {
        timeout: 5000,
        maxRetries: 3,
        backoffStrategy: 'exponential',
        backoffOffset: 100,
        onRetry,
      });

      expect(onRetry).toHaveBeenCalledTimes(2);

      // First retry
      expect(onRetry).toHaveBeenNthCalledWith(
        1,
        1, // attempt number
        expect.any(Error), // error
        100 // delay (2^0 * 100)
      );

      // Second retry
      expect(onRetry).toHaveBeenNthCalledWith(
        2,
        2, // attempt number
        expect.any(Error), // error
        200 // delay (2^1 * 100)
      );
    });
  });

  describe('error handling', () => {
    it('throws original error if fn throws non-Error', async () => {
      const fn = jest.fn().mockRejectedValue('string error');

      const caught = await rejection(retryWithBackoff(fn, { timeout: 100, maxRetries: 0 }));

      expect(caught).toBeInstanceOf(RetryExhaustedError);
      if (!(caught instanceof RetryExhaustedError)) return;
      expect(caught.lastError.message).toBe('string error');
    });

    it('includes attempt count in error', async () => {
      const fn = jest.fn().mockRejectedValue(new Error('fail'));

      const caught = await rejection(retryWithBackoff(fn, { timeout: 100, maxRetries: 2 }));

      expect(caught).toBeInstanceOf(RetryExhaustedError);
      if (!(caught instanceof RetryExhaustedError)) return;
      expect(caught.attempts).toBeGreaterThan(0);
    });
  });

  describe('defaults', () => {
    it('uses default options when none provided', async () => {
      const fn = jest.fn().mockResolvedValue('success');
      const result = await retryWithBackoff(fn);

      expect(result).toBe('success');
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it('defaults to 3 total attempts (maxRetries=2)', async () => {
      const fn = jest.fn().mockRejectedValue(new Error('fail'));
      const attempts: number[] = [];

      await rejection(retryWithBackoff(fn, { timeout: 5000, onRetry: () => attempts.push(1) }));

      // 1 initial + 2 retries
      expect(attempts.length).toBe(2);
      expect(fn).toHaveBeenCalledTimes(3);
    });

    it('defaults to exponential backoff with 1s offset', async () => {
      const fn = jest.fn().mockRejectedValue(new Error('fail'));
      const delays: number[] = [];

      await rejection(
        retryWithBackoff(fn, {
          timeout: 10000,
          maxRetries: 2,
          onRetry: (attempt, error, delay) => delays.push(delay),
        })
      );

      // Exponential with 1s offset: 1s, 2s
      expect(delays).toEqual([1000, 2000]);
    });
  });
});
