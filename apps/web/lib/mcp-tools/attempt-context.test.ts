import {
  ATTEMPT_HEADER,
  ATTEMPT_MAX_HEADER,
  attemptFromHeaders,
  currentAttempt,
  retryNote,
  withAttempt,
} from './attempt-context';

function headers(values: Record<string, string>): Headers {
  return new Headers(values);
}

describe('attemptFromHeaders', () => {
  it('reads a well-formed pair', () => {
    expect(
      attemptFromHeaders(headers({ [ATTEMPT_HEADER]: '2', [ATTEMPT_MAX_HEADER]: '3' }))
    ).toEqual({ attempt: 2, maxAttempts: 3 });
  });

  it('takes the pair or neither, so a half-parse never reads as truth', () => {
    expect(attemptFromHeaders(headers({ [ATTEMPT_HEADER]: '2' }))).toBeUndefined();
    expect(attemptFromHeaders(headers({ [ATTEMPT_MAX_HEADER]: '3' }))).toBeUndefined();
  });

  it('refuses nonsense rather than passing NaN downstream', () => {
    expect(
      attemptFromHeaders(headers({ [ATTEMPT_HEADER]: 'two', [ATTEMPT_MAX_HEADER]: '3' }))
    ).toBeUndefined();
    expect(
      attemptFromHeaders(headers({ [ATTEMPT_HEADER]: '0', [ATTEMPT_MAX_HEADER]: '3' }))
    ).toBeUndefined();
    expect(
      attemptFromHeaders(headers({ [ATTEMPT_HEADER]: '1.5', [ATTEMPT_MAX_HEADER]: '3' }))
    ).toBeUndefined();
    // An attempt past the ceiling is incoherent, not merely unusual.
    expect(
      attemptFromHeaders(headers({ [ATTEMPT_HEADER]: '4', [ATTEMPT_MAX_HEADER]: '3' }))
    ).toBeUndefined();
  });

  it('finds nothing on a request that carries neither header', () => {
    expect(attemptFromHeaders(headers({}))).toBeUndefined();
  });
});

describe('withAttempt', () => {
  it('is invisible outside its scope', () => {
    expect(currentAttempt()).toBeUndefined();
    withAttempt({ attempt: 2, maxAttempts: 3 }, () => {
      expect(currentAttempt()).toEqual({ attempt: 2, maxAttempts: 3 });
    });
    expect(currentAttempt()).toBeUndefined();
  });

  it('survives awaits, which is the whole reason it is not a field', async () => {
    await withAttempt({ attempt: 3, maxAttempts: 5 }, async () => {
      await Promise.resolve();
      expect(currentAttempt()).toEqual({ attempt: 3, maxAttempts: 5 });
    });
  });

  it('keeps concurrent scopes from seeing each other', async () => {
    // Two runs of the same agent share one cached handler; this is the race
    // a mutable field on the context would lose.
    const seen: number[] = [];
    const one = withAttempt({ attempt: 1, maxAttempts: 3 }, async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      seen.push(currentAttempt()!.attempt);
    });
    const two = withAttempt({ attempt: 2, maxAttempts: 3 }, async () => {
      seen.push(currentAttempt()!.attempt);
    });
    await Promise.all([one, two]);

    expect(seen.sort()).toEqual([1, 2]);
  });

  it('runs the work unchanged when there is no attempt', () => {
    expect(withAttempt(undefined, () => 'ran')).toBe('ran');
    expect(currentAttempt()).toBeUndefined();
  });
});

describe('retryNote', () => {
  it('says nothing on a first try', () => {
    withAttempt({ attempt: 1, maxAttempts: 3 }, () => {
      expect(retryNote()).toBeUndefined();
    });
  });

  it('says nothing for a person calling the tool directly', () => {
    expect(retryNote()).toBeUndefined();
  });

  it('uses the builder’s "tries" wording on a retry', () => {
    withAttempt({ attempt: 2, maxAttempts: 3 }, () => {
      expect(retryNote()).toBe('(try 2 of 3 — the previous try did not succeed.)');
    });
  });
});
