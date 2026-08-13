/**
 * The retry policy every adapter shares: exponential backoff (30s, 60s,
 * 120s, ... capped at an hour) until the attempt budget is spent, then
 * dead-letter.
 */

import { failureDisposition, DEFAULT_RETRY_POLICY } from './policy';

describe('failureDisposition', () => {
  it('backs off exponentially from 30 seconds', () => {
    expect(failureDisposition(1)).toEqual({ status: 'retry', delaySeconds: 30 });
    expect(failureDisposition(2)).toEqual({ status: 'retry', delaySeconds: 60 });
    expect(failureDisposition(3)).toEqual({ status: 'retry', delaySeconds: 120 });
    expect(failureDisposition(4)).toEqual({ status: 'retry', delaySeconds: 240 });
  });

  it('caps the delay at an hour', () => {
    expect(failureDisposition(9, { maxAttempts: 10, baseDelaySeconds: 30, maxDelaySeconds: 3600 }))
      .toEqual({ status: 'retry', delaySeconds: 3600 });
  });

  it('dead-letters once the budget is spent', () => {
    expect(failureDisposition(5)).toEqual({ status: 'dead' });
    expect(failureDisposition(6)).toEqual({ status: 'dead' });
  });

  it('honors a per-queue policy', () => {
    const policy = { maxAttempts: 2, baseDelaySeconds: 5, maxDelaySeconds: 60 };
    expect(failureDisposition(1, policy)).toEqual({ status: 'retry', delaySeconds: 5 });
    expect(failureDisposition(2, policy)).toEqual({ status: 'dead' });
  });

  it('keeps the historical default budget of five deliveries', () => {
    expect(DEFAULT_RETRY_POLICY.maxAttempts).toBe(5);
  });
});
