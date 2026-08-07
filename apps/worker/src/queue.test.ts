/**
 * The retry policy is the queue's contract with producers: how many chances
 * an event gets and how fast they come. Pinned here so a change to it is a
 * deliberate edit, not a side effect.
 */

import { failureDisposition, MAX_ATTEMPTS } from './policy';

describe('failureDisposition', () => {
  it('retries with exponential backoff before the budget is spent', () => {
    expect(failureDisposition(1)).toEqual({ status: 'pending', delaySeconds: 30 });
    expect(failureDisposition(2)).toEqual({ status: 'pending', delaySeconds: 60 });
    expect(failureDisposition(3)).toEqual({ status: 'pending', delaySeconds: 120 });
    expect(failureDisposition(4)).toEqual({ status: 'pending', delaySeconds: 240 });
  });

  it('caps the backoff at an hour', () => {
    expect(failureDisposition(9, 20)).toEqual({ status: 'pending', delaySeconds: 3600 });
  });

  it('dead-letters once attempts reach the budget', () => {
    expect(failureDisposition(MAX_ATTEMPTS)).toEqual({ status: 'dead' });
    expect(failureDisposition(MAX_ATTEMPTS + 1)).toEqual({ status: 'dead' });
  });
});
