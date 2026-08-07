/**
 * The queue's retry policy, dependency-free so it is testable without a
 * database (and without loading ESM-only modules under jest).
 */

/** Attempts before a row is dead-lettered instead of retried. */
export const MAX_ATTEMPTS = 5;

export type Disposition =
  | { status: 'pending'; delaySeconds: number }
  | { status: 'dead' };

/**
 * What happens to a failed event: retry with exponential backoff
 * (30s, 60s, 120s, ... capped at an hour) until the budget is spent,
 * then dead-letter.
 */
export function failureDisposition(attempts: number, maxAttempts = MAX_ATTEMPTS): Disposition {
  if (attempts >= maxAttempts) return { status: 'dead' };
  return { status: 'pending', delaySeconds: Math.min(30 * 2 ** (attempts - 1), 3600) };
}
