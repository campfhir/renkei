/**
 * The retry helper's contract. The backoff suites assert the delays the
 * module REPORTS through onRetry rather than the wall clock it burns, so the
 * offsets here are deliberately tiny — proving 10ms/20ms/40ms is the same
 * proof as 1s/2s/4s and costs the suite milliseconds instead of seconds.
 *
 * Web standards only, like the module itself: no node: imports, so these
 * tests keep passing if the suite is ever run in a browser environment.
 */

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

      const result = await retryWithBackoff(fn, {
        timeout: 5000,
        maxRetries: 2,
        backoffOffset: 10,
      });
      expect(result).toBe('success');
      expect(fn).toHaveBeenCalledTimes(2);
    });

    it('succeeds after multiple retries', async () => {
      const fn = jest.fn();
      fn.mockRejectedValueOnce(new Error('fail 1'));
      fn.mockRejectedValueOnce(new Error('fail 2'));
      fn.mockResolvedValueOnce('success');

      const result = await retryWithBackoff(fn, {
        timeout: 5000,
        maxRetries: 3,
        backoffOffset: 10,
      });
      expect(result).toBe('success');
      expect(fn).toHaveBeenCalledTimes(3);
    });
  });

  describe('exponential backoff', () => {
    it('doubles the delay each retry', async () => {
      const fn = jest.fn().mockRejectedValue(new Error('fail'));
      const delays: number[] = [];

      await rejection(
        retryWithBackoff(fn, {
          timeout: 10000,
          maxRetries: 3,
          backoffStrategy: 'exponential',
          backoffOffset: 10,
          onRetry: (attempt, error, delay) => {
            delays.push(delay);
          },
        })
      );

      // offset * 2^0, 2^1, 2^2
      expect(delays).toEqual([10, 20, 40]);
    });

    it('respects custom backoff offset', async () => {
      const fn = jest.fn().mockRejectedValue(new Error('fail'));
      const delays: number[] = [];

      await rejection(
        retryWithBackoff(fn, {
          timeout: 10000,
          maxRetries: 2,
          backoffStrategy: 'exponential',
          backoffOffset: 5,
          onRetry: (attempt, error, delay) => {
            delays.push(delay);
          },
        })
      );

      expect(delays).toEqual([5, 10]);
    });
  });

  describe('linear backoff', () => {
    it('adds the offset each retry', async () => {
      const fn = jest.fn().mockRejectedValue(new Error('fail'));
      const delays: number[] = [];

      await rejection(
        retryWithBackoff(fn, {
          timeout: 10000,
          maxRetries: 3,
          backoffStrategy: 'linear',
          backoffOffset: 10,
          onRetry: (attempt, error, delay) => {
            delays.push(delay);
          },
        })
      );

      // offset * 1, 2, 3 — the third delay is what separates this from
      // exponential, which would be 40 here.
      expect(delays).toEqual([10, 20, 30]);
    });

    it('respects custom backoff offset for linear', async () => {
      const fn = jest.fn().mockRejectedValue(new Error('fail'));
      const delays: number[] = [];

      await rejection(
        retryWithBackoff(fn, {
          timeout: 10000,
          maxRetries: 2,
          backoffStrategy: 'linear',
          backoffOffset: 5,
          onRetry: (attempt, error, delay) => {
            delays.push(delay);
          },
        })
      );

      expect(delays).toEqual([5, 10]);
    });
  });

  describe('timeout behavior', () => {
    it('throws RetryExhaustedError when timeout is exceeded', async () => {
      const fn = jest.fn().mockRejectedValue(new Error('fail'));

      await expect(
        retryWithBackoff(fn, {
          timeout: 100,
          maxRetries: 5,
          backoffOffset: 500, // A single delay already overruns the timeout
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

    it('gives up within the custom timeout rather than running all retries', async () => {
      const fn = jest.fn().mockRejectedValue(new Error('fail'));
      const startTime = Date.now();

      await expect(
        retryWithBackoff(fn, {
          timeout: 300,
          maxRetries: 10, // 10 retries at these delays would far outlast 300ms
          backoffOffset: 50,
        })
      ).rejects.toThrow(RetryExhaustedError);

      // Bounded by the timeout, not by maxRetries. Generous upper bound so a
      // loaded CI box doesn't turn this into a flake.
      expect(Date.now() - startTime).toBeLessThan(800);
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

      // A long backoff so the abort lands squarely inside the wait.
      const promise = retryWithBackoff(fn, {
        timeout: 10000,
        maxRetries: 5,
        backoffOffset: 1000,
        signal: controller.signal,
      });

      const startTime = Date.now();
      setTimeout(() => controller.abort(), 30);

      await expect(promise).rejects.toThrow(OperationAbortedError);

      // Cut the wait short instead of serving all 1000ms of it.
      expect(Date.now() - startTime).toBeLessThan(500);
      // Attempted once, then interrupted during the first backoff
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it('aborts while an attempt is still running, without waiting it out', async () => {
      const controller = new AbortController();
      // Settles far later than the abort: if the signal were only consulted
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
      setTimeout(() => controller.abort(), 30);

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
      // A listener left on a caller-owned signal accumulates across calls and
      // trips the host's max-listeners warning. EventTarget exposes no
      // listener count, so watch the calls: every add needs a matching
      // remove. (Counting via the standard EventTarget methods keeps this
      // test free of any node: import.)
      const controller = new AbortController();
      const added = jest.spyOn(controller.signal, 'addEventListener');
      const removed = jest.spyOn(controller.signal, 'removeEventListener');
      const fn = jest.fn().mockResolvedValue('success');

      for (let i = 0; i < 20; i++) {
        await retryWithBackoff(fn, { timeout: 5000, signal: controller.signal });
      }

      expect(added).toHaveBeenCalledTimes(20);
      expect(removed).toHaveBeenCalledTimes(20);
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
        backoffOffset: 10,
        onRetry,
      });

      expect(onRetry).toHaveBeenCalledTimes(2);

      // First retry
      expect(onRetry).toHaveBeenNthCalledWith(
        1,
        1, // attempt number
        expect.any(Error), // error
        10 // delay (2^0 * 10)
      );

      // Second retry
      expect(onRetry).toHaveBeenNthCalledWith(
        2,
        2, // attempt number
        expect.any(Error), // error
        20 // delay (2^1 * 10)
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

      await rejection(
        retryWithBackoff(fn, {
          timeout: 5000,
          backoffOffset: 10,
          onRetry: () => attempts.push(1),
        })
      );

      // 1 initial + 2 retries
      expect(attempts.length).toBe(2);
      expect(fn).toHaveBeenCalledTimes(3);
    });

    it('defaults to the exponential strategy', async () => {
      const fn = jest.fn().mockRejectedValue(new Error('fail'));
      const delays: number[] = [];

      await rejection(
        retryWithBackoff(fn, {
          timeout: 10000,
          maxRetries: 3, // three retries: linear and exponential diverge only
          backoffOffset: 10, // on the third (30 vs 40)
          onRetry: (attempt, error, delay) => delays.push(delay),
        })
      );

      expect(delays).toEqual([10, 20, 40]);
    });

    it('defaults to a 1s backoff offset', async () => {
      const fn = jest.fn().mockRejectedValue(new Error('fail'));
      const delays: number[] = [];

      // The one test that must pay real time: the default offset can only be
      // observed by letting the module actually schedule it. One retry, 1s.
      await rejection(
        retryWithBackoff(fn, {
          timeout: 10000,
          maxRetries: 1,
          onRetry: (attempt, error, delay) => delays.push(delay),
        })
      );

      expect(delays).toEqual([1000]);
    });
  });
});
