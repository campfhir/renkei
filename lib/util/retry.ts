/**
 * Exponential backoff retry for transient failures.
 *
 * Retries on network errors and specific HTTP statuses (429, 503, 504).
 * Gives up on auth errors (401) and client errors (4xx except 429).
 */

export interface RetryOptions {
  maxAttempts?: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
  backoffFactor?: number;
  isRetryable?: (error: unknown) => boolean;
}

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_INITIAL_DELAY_MS = 100;
const DEFAULT_MAX_DELAY_MS = 5000;
const DEFAULT_BACKOFF_FACTOR = 2;

export class RetryExhaustedError extends Error {
  constructor(
    readonly lastError: unknown,
    readonly attempts: number,
  ) {
    super(
      lastError instanceof Error
        ? `Retry exhausted after ${attempts} attempts: ${lastError.message}`
        : `Retry exhausted after ${attempts} attempts`,
    );
    this.name = 'RetryExhaustedError';
  }
}

export async function withRetry<T>(fn: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const initialDelayMs = options.initialDelayMs ?? DEFAULT_INITIAL_DELAY_MS;
  const maxDelayMs = options.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
  const backoffFactor = options.backoffFactor ?? DEFAULT_BACKOFF_FACTOR;
  const isRetryable = options.isRetryable ?? defaultIsRetryable;

  let lastError: unknown;
  let delayMs = initialDelayMs;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;

      if (!isRetryable(error) || attempt === maxAttempts) {
        throw error;
      }

      await sleep(delayMs);
      delayMs = Math.min(delayMs * backoffFactor, maxDelayMs);
    }
  }

  throw new RetryExhaustedError(lastError, maxAttempts);
}

function defaultIsRetryable(error: unknown): boolean {
  // Network errors
  if (error instanceof TypeError) {
    const message = error.message.toLowerCase();
    if (
      message.includes('fetch') ||
      message.includes('network') ||
      message.includes('timeout') ||
      message.includes('econnrefused') ||
      message.includes('enotfound')
    ) {
      return true;
    }
  }

  // HTTP status codes that are transient
  if (error instanceof HttpRetryableError) {
    return true;
  }

  return false;
}

export class HttpRetryableError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'HttpRetryableError';
  }
}

export function isTransientHttpStatus(status: number): boolean {
  return status === 429 || status === 503 || status === 504;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
