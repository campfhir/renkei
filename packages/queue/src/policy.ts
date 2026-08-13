/**
 * The retry policy, dependency-free so it is testable without a database
 * and shared verbatim by every adapter (Postgres, in-memory, and whatever
 * broker replaces them).
 */

import type { Disposition } from './contract';

export interface RetryPolicy {
  /** Deliveries before a message is dead-lettered instead of retried. */
  maxAttempts: number;
  /** First retry delay; doubles per attempt. */
  baseDelaySeconds: number;
  /** Backoff ceiling. */
  maxDelaySeconds: number;
}

/** 5 deliveries, 30s → 60s → 120s → 240s backoff capped at an hour. */
export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 5,
  baseDelaySeconds: 30,
  maxDelaySeconds: 3600,
};

/**
 * What happens to a message that failed its `attempts`-th delivery:
 * exponential backoff until the budget is spent, then dead.
 */
export function failureDisposition(
  attempts: number,
  policy: RetryPolicy = DEFAULT_RETRY_POLICY
): Disposition {
  if (attempts >= policy.maxAttempts) return { status: 'dead' };
  return {
    status: 'retry',
    delaySeconds: Math.min(policy.baseDelaySeconds * 2 ** (attempts - 1), policy.maxDelaySeconds),
  };
}
