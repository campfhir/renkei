/**
 * General-purpose async operation with configurable retry logic and backoff strategies.
 * Supports timeouts, multiple backoff algorithms, and custom abort signals.
 */

export interface RetryOptions {
  /**
   * Maximum total time for the operation including all retries, in milliseconds.
   * Defaults to 180000 (3 minutes).
   */
  timeout?: number;

  /**
   * Maximum number of retry attempts after the initial attempt.
   * Total attempts = 1 + maxRetries. Defaults to 2 (3 total attempts).
   */
  maxRetries?: number;

  /**
   * Backoff strategy for retry delays.
   * - 'linear': delay = backoffOffset * attemptNumber
   * - 'exponential': delay = backoffOffset * (2 ^ attemptNumber)
   * Defaults to 'exponential'.
   */
  backoffStrategy?: 'linear' | 'exponential';

  /**
   * Base delay in milliseconds for backoff calculation.
   * - For linear: each retry waits backoffOffset * (retryNumber + 1) ms
   * - For exponential: retry 1 waits backoffOffset ms, retry 2 waits backoffOffset * 2 ms, etc.
   * Defaults to 1000 (1 second).
   */
  backoffOffset?: number;

  /**
   * Optional abort signal to cancel the operation at any time.
   * If the signal is already aborted, the operation fails immediately.
   */
  signal?: AbortSignal;

  /**
   * Optional callback invoked before each retry.
   * Useful for logging, metrics, or custom logic.
   */
  onRetry?: (attempt: number, error: Error, nextDelayMs: number) => void;
}

export class RetryExhaustedError extends Error {
  constructor(
    message: string,
    readonly lastError: Error,
    readonly attempts: number
  ) {
    super(message);
    this.name = 'RetryExhaustedError';
  }
}

export class OperationAbortedError extends Error {
  constructor(message: string = 'Operation was aborted') {
    super(message);
    this.name = 'OperationAbortedError';
  }
}

/**
 * Execute an async operation with automatic retry and backoff on failure.
 *
 * @param fn The async function to execute
 * @param options Configuration for retry behavior
 * @returns The result of a successful operation
 * @throws {OperationAbortedError} If the operation was aborted
 * @throws {RetryExhaustedError} If all retries are exhausted
 * @throws The original error if it occurs and cannot be retried
 *
 * @example
 * // Simple usage with defaults (3 attempts, exponential backoff)
 * const result = await retryWithBackoff(() => llm.complete(...));
 *
 * @example
 * // Custom configuration
 * const result = await retryWithBackoff(
 *   () => llm.complete(...),
 *   {
 *     timeout: 180_000,           // 3 minutes total
 *     maxRetries: 3,              // 4 total attempts
 *     backoffStrategy: 'exponential',
 *     backoffOffset: 2_000,       // Start at 2 seconds
 *     signal: abortController.signal,
 *     onRetry: (attempt, error, delay) => {
 *       console.log(`Retry ${attempt} after ${error.message}, waiting ${delay}ms`);
 *     }
 *   }
 * );
 *
 * @example
 * // With linear backoff (1s, 2s, 3s, ...)
 * const result = await retryWithBackoff(
 *   () => fetch(url),
 *   {
 *     maxRetries: 2,
 *     backoffStrategy: 'linear',
 *     backoffOffset: 1_000,
 *   }
 * );
 */
export async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {}
): Promise<T> {
  const {
    timeout = 180_000,
    maxRetries = 2,
    backoffStrategy = 'exponential',
    backoffOffset = 1_000,
    signal,
    onRetry,
  } = options;

  // Check if already aborted
  if (signal?.aborted) {
    throw new OperationAbortedError();
  }

  const startTime = Date.now();
  const totalAttempts = 1 + maxRetries;
  let lastError: Error | null = null;

  for (let attemptNumber = 0; attemptNumber < totalAttempts; attemptNumber++) {
    // Check timeout before attempting
    const elapsed = Date.now() - startTime;
    if (elapsed >= timeout) {
      throw new RetryExhaustedError(
        `Operation timed out after ${elapsed}ms (timeout: ${timeout}ms) and ${attemptNumber} attempt${attemptNumber === 1 ? '' : 's'}`,
        lastError || new Error('Unknown error'),
        attemptNumber
      );
    }

    // Check if aborted before attempting
    if (signal?.aborted) {
      throw new OperationAbortedError();
    }

    // Set up timeout for this specific attempt
    const remainingTime = timeout - elapsed;
    const attemptTimeout = Math.min(60_000, remainingTime); // Cap individual attempts at 60s

    // Both the timer and the abort listener MUST be torn down once the
    // attempt settles. A surviving timer keeps the Node event loop alive for
    // its full duration (60s on a default-timeout call, on every success),
    // and a surviving listener accumulates on a signal the caller reuses.
    let attemptTimer: ReturnType<typeof setTimeout> | undefined;
    let attemptAbortHandler: (() => void) | undefined;

    try {
      const result = await new Promise<T>((resolve, reject) => {
        attemptTimer = setTimeout(
          () => reject(new Error(`Attempt ${attemptNumber + 1} exceeded ${attemptTimeout}ms`)),
          attemptTimeout
        );

        // Racing the signal is what makes abort responsive DURING an
        // attempt. Without it an abort sits unnoticed until the attempt
        // finishes on its own — up to the full 60s cap.
        if (signal) {
          attemptAbortHandler = () => reject(new OperationAbortedError());
          signal.addEventListener('abort', attemptAbortHandler, { once: true });
        }

        fn().then(resolve, reject);
      });

      return result;
    } catch (error) {
      // An abort is the caller's decision, not a failure to retry against.
      if (error instanceof OperationAbortedError) throw error;

      lastError = error instanceof Error ? error : new Error(String(error));

      // If this was the last attempt, throw
      if (attemptNumber === totalAttempts - 1) {
        throw new RetryExhaustedError(
          `Operation failed after ${totalAttempts} attempt${totalAttempts === 1 ? '' : 's'}: ${lastError.message}`,
          lastError,
          totalAttempts
        );
      }

      // Calculate delay before next retry
      const nextRetryNumber = attemptNumber + 1;
      const delay =
        backoffStrategy === 'exponential'
          ? backoffOffset * Math.pow(2, nextRetryNumber - 1)
          : backoffOffset * nextRetryNumber;

      // Check if retry delay would exceed timeout
      const elapsedWithDelay = elapsed + delay;
      if (elapsedWithDelay >= timeout) {
        throw new RetryExhaustedError(
          `Cannot retry after ${timeout}ms timeout (would need to wait ${delay}ms, elapsed: ${elapsed}ms)`,
          lastError,
          attemptNumber + 1
        );
      }

      // Invoke callback before waiting
      if (onRetry) {
        onRetry(attemptNumber + 1, lastError, delay);
      }

      // Wait before retrying, but be interruptible by abort signal
      await new Promise<void>((resolve, reject) => {
        let abortHandler: (() => void) | undefined;

        const timeoutHandle = setTimeout(() => {
          // The wait finished without an abort — drop the listener, or it
          // outlives every retry on a caller-owned signal.
          if (abortHandler) signal?.removeEventListener('abort', abortHandler);
          resolve();
        }, delay);

        if (signal) {
          abortHandler = () => {
            clearTimeout(timeoutHandle);
            reject(new OperationAbortedError());
          };
          signal.addEventListener('abort', abortHandler, { once: true });
        }
      });
    } finally {
      if (attemptTimer !== undefined) clearTimeout(attemptTimer);
      if (attemptAbortHandler) signal?.removeEventListener('abort', attemptAbortHandler);
    }
  }

  // Should never reach here
  throw new RetryExhaustedError(
    `Unexpected error in retry logic`,
    lastError || new Error('Unknown error'),
    totalAttempts
  );
}
