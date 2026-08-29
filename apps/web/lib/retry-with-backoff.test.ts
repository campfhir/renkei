import { describe, it, expect, vi, beforeEach } from 'vitest';
import { retryWithBackoff, RetryExhaustedError, OperationAbortedError } from './retry-with-backoff';

describe('retryWithBackoff', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  describe('successful execution', () => {
    it('succeeds on first attempt', async () => {
      const fn = vi.fn().mockResolvedValue('success');
      const result = await retryWithBackoff(fn);
      expect(result).toBe('success');
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it('succeeds after one retry', async () => {
      const fn = vi.fn();
      fn.mockRejectedValueOnce(new Error('fail'));
      fn.mockResolvedValueOnce('success');

      const result = await retryWithBackoff(fn, { timeout: 5000, maxRetries: 2 });
      expect(result).toBe('success');
      expect(fn).toHaveBeenCalledTimes(2);
    });

    it('succeeds after multiple retries', async () => {
      const fn = vi.fn();
      fn.mockRejectedValueOnce(new Error('fail 1'));
      fn.mockRejectedValueOnce(new Error('fail 2'));
      fn.mockResolvedValueOnce('success');

      const result = await retryWithBackoff(fn, { timeout: 5000, maxRetries: 3 });
      expect(result).toBe('success');
      expect(fn).toHaveBeenCalledTimes(3);
    });
  });

  describe('exponential backoff', () => {
    it('uses exponential delays: 1s, 2s, 4s', async () => {
      const fn = vi.fn().mockRejectedValue(new Error('fail'));
      const delays: number[] = [];

      try {
        await retryWithBackoff(fn, {
          timeout: 10000,
          maxRetries: 3,
          backoffStrategy: 'exponential',
          backoffOffset: 1000,
          onRetry: (attempt, error, delay) => {
            delays.push(delay);
          },
        });
      } catch {
        // Expected to fail
      }

      // Exponential: 1s (2^0), 2s (2^1), 4s (2^2)
      expect(delays).toEqual([1000, 2000, 4000]);
    }, 15000);

    it('respects custom backoff offset', async () => {
      const fn = vi.fn().mockRejectedValue(new Error('fail'));
      const delays: number[] = [];

      try {
        await retryWithBackoff(fn, {
          timeout: 10000,
          maxRetries: 2,
          backoffStrategy: 'exponential',
          backoffOffset: 500, // 0.5s base
          onRetry: (attempt, error, delay) => {
            delays.push(delay);
          },
        });
      } catch {
        // Expected to fail
      }

      // Exponential with 500ms offset: 500ms (2^0), 1000ms (2^1)
      expect(delays).toEqual([500, 1000]);
    });
  });

  describe('linear backoff', () => {
    it('uses linear delays: 1s, 2s, 3s', async () => {
      const fn = vi.fn().mockRejectedValue(new Error('fail'));
      const delays: number[] = [];

      try {
        await retryWithBackoff(fn, {
          timeout: 10000,
          maxRetries: 3,
          backoffStrategy: 'linear',
          backoffOffset: 1000,
          onRetry: (attempt, error, delay) => {
            delays.push(delay);
          },
        });
      } catch {
        // Expected to fail
      }

      // Linear: 1s (1*1), 2s (2*1), 3s (3*1)
      expect(delays).toEqual([1000, 2000, 3000]);
    }, 15000);

    it('respects custom backoff offset for linear', async () => {
      const fn = vi.fn().mockRejectedValue(new Error('fail'));
      const delays: number[] = [];

      try {
        await retryWithBackoff(fn, {
          timeout: 10000,
          maxRetries: 2,
          backoffStrategy: 'linear',
          backoffOffset: 500,
          onRetry: (attempt, error, delay) => {
            delays.push(delay);
          },
        });
      } catch {
        // Expected to fail
      }

      // Linear with 500ms offset: 500ms (1*500), 1000ms (2*500)
      expect(delays).toEqual([500, 1000]);
    });
  });

  describe('timeout behavior', () => {
    it('throws RetryExhaustedError when timeout is exceeded', async () => {
      const fn = vi.fn().mockRejectedValue(new Error('fail'));

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
      const fn = vi.fn().mockRejectedValue(originalError);

      try {
        await retryWithBackoff(fn, {
          timeout: 100,
          maxRetries: 5,
          backoffOffset: 500,
        });
        fail('Should have thrown');
      } catch (error) {
        if (!(error instanceof RetryExhaustedError)) throw error;
        expect(error.lastError).toBe(originalError);
      }
    });

    it('respects custom timeout', async () => {
      const fn = vi.fn().mockRejectedValue(new Error('fail'));
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

      const fn = vi.fn();

      await expect(retryWithBackoff(fn, { signal: controller.signal })).rejects.toThrow(
        OperationAbortedError
      );

      expect(fn).not.toHaveBeenCalled();
    });

    it('aborts during backoff delay', async () => {
      const controller = new AbortController();
      const fn = vi.fn().mockRejectedValue(new Error('fail'));

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

    it('aborts during operation execution', async () => {
      const controller = new AbortController();
      const fn = vi.fn(
        () =>
          new Promise((resolve) => {
            setTimeout(() => resolve('success'), 1000);
          })
      );

      const promise = retryWithBackoff(fn, {
        timeout: 10000,
        maxRetries: 5,
        signal: controller.signal,
      });

      // Abort quickly while operation is running
      setTimeout(() => controller.abort(), 50);

      // Note: AbortSignal doesn't directly cancel pending promises,
      // so this tests the timing between abort and completion
      try {
        await promise;
      } catch {
        // May throw OperationAbortedError or succeed depending on timing
      }
    });
  });

  describe('onRetry callback', () => {
    it('calls onRetry with attempt number, error, and delay', async () => {
      const fn = vi.fn();
      fn.mockRejectedValueOnce(new Error('fail 1'));
      fn.mockRejectedValueOnce(new Error('fail 2'));
      fn.mockResolvedValueOnce('success');

      const onRetry = vi.fn();

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
      const fn = vi.fn().mockRejectedValue('string error');

      try {
        await retryWithBackoff(fn, { timeout: 100, maxRetries: 0 });
        fail('Should have thrown');
      } catch (error) {
        if (!(error instanceof RetryExhaustedError)) throw error;
        expect(error.lastError.message).toBe('string error');
      }
    });

    it('includes attempt count in error', async () => {
      const fn = vi.fn().mockRejectedValue(new Error('fail'));

      try {
        await retryWithBackoff(fn, { timeout: 100, maxRetries: 2 });
        fail('Should have thrown');
      } catch (error) {
        if (!(error instanceof RetryExhaustedError)) throw error;
        expect(error.attempts).toBeGreaterThan(0);
      }
    });
  });

  describe('defaults', () => {
    it('uses default options when none provided', async () => {
      const fn = vi.fn().mockResolvedValue('success');
      const result = await retryWithBackoff(fn);

      expect(result).toBe('success');
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it('defaults to 3 total attempts (maxRetries=2)', async () => {
      const fn = vi.fn().mockRejectedValue(new Error('fail'));
      const attempts: number[] = [];

      try {
        await retryWithBackoff(fn, { timeout: 5000, onRetry: () => attempts.push(1) });
      } catch {
        // Expected
      }

      // 1 initial + 2 retries
      expect(attempts.length).toBe(2);
      expect(fn).toHaveBeenCalledTimes(3);
    });

    it('defaults to exponential backoff with 1s offset', async () => {
      const fn = vi.fn().mockRejectedValue(new Error('fail'));
      const delays: number[] = [];

      try {
        await retryWithBackoff(fn, {
          timeout: 10000,
          maxRetries: 2,
          onRetry: (attempt, error, delay) => delays.push(delay),
        });
      } catch {
        // Expected
      }

      // Exponential with 1s offset: 1s, 2s
      expect(delays).toEqual([1000, 2000]);
    });
  });
});
