import {
  ONBASE_SESSION_COOKIE,
  clearSessions,
  extractSessionCookie,
  forgetSession,
  rememberSession,
  sessionCookie,
  sessionCount,
} from './sessions';

const SET = (value: string) =>
  `${ONBASE_SESSION_COOKIE}=${value}; path=/; secure; HttpOnly; SameSite=Lax`;

beforeEach(() => clearSessions());

describe('extractSessionCookie', () => {
  it('takes the name=value pair and drops the attributes', () => {
    expect(extractSessionCookie([SET('abc123')])).toBe(`${ONBASE_SESSION_COOKIE}=abc123`);
  });

  it('finds it among other cookies the server sets', () => {
    expect(extractSessionCookie(['other=1; path=/', SET('abc123'), 'another=2'])).toBe(
      `${ONBASE_SESSION_COOKIE}=abc123`
    );
  });

  it('survives an Expires date, whose comma looks like a cookie separator', () => {
    expect(
      extractSessionCookie([`x=1; Expires=Wed, 21 Oct 2026 07:28:00 GMT, ${SET('abc123')}`])
    ).toBe(`${ONBASE_SESSION_COOKIE}=abc123`);
  });

  it('finds nothing when the session cookie is absent', () => {
    expect(extractSessionCookie(['other=1; path=/'])).toBeUndefined();
    expect(extractSessionCookie([])).toBeUndefined();
  });
});

describe('session reuse', () => {
  it('gives back what it stored, so the next call reuses the session', () => {
    rememberSession('t1', 's1', [SET('abc')]);
    expect(sessionCookie('t1', 's1')).toBe(`${ONBASE_SESSION_COOKIE}=abc`);
  });

  it('never hands one person another person’s session', () => {
    // The licensing bug is expensive; this one would act in OnBase AS the
    // wrong user, so it is the property most worth pinning.
    rememberSession('t1', 's1', [SET('abc')]);
    expect(sessionCookie('t1', 's2')).toBeUndefined();
    expect(sessionCookie('t2', 's1')).toBeUndefined();
  });

  it('forgets on demand, which is what a 401 does', () => {
    rememberSession('t1', 's1', [SET('abc')]);
    forgetSession('t1', 's1');
    expect(sessionCookie('t1', 's1')).toBeUndefined();
  });

  it('expires just under the server’s five-minute idle window', () => {
    jest.useFakeTimers();
    try {
      rememberSession('t1', 's1', [SET('abc')]);
      jest.advanceTimersByTime(4 * 60_000 - 1);
      expect(sessionCookie('t1', 's1')).toBeDefined();
      jest.advanceTimersByTime(2);
      expect(sessionCookie('t1', 's1')).toBeUndefined();
      expect(sessionCount()).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  });

  it('extends the window on every response, as each request does server-side', () => {
    jest.useFakeTimers();
    try {
      rememberSession('t1', 's1', [SET('abc')]);
      jest.advanceTimersByTime(3 * 60_000);
      rememberSession('t1', 's1', [SET('abc')]);
      jest.advanceTimersByTime(3 * 60_000);
      expect(sessionCookie('t1', 's1')).toBeDefined();
    } finally {
      jest.useRealTimers();
    }
  });

  it('ignores a response that carried no cookie, keeping the live one', () => {
    rememberSession('t1', 's1', [SET('abc')]);
    rememberSession('t1', 's1', []);
    expect(sessionCookie('t1', 's1')).toBe(`${ONBASE_SESSION_COOKIE}=abc`);
  });

  it('stays bounded', () => {
    for (let i = 0; i < 1_200; i += 1) rememberSession('t1', `s${i}`, [SET(`c${i}`)]);
    expect(sessionCount()).toBe(1_000);
    expect(sessionCookie('t1', 's0')).toBeUndefined();
    expect(sessionCookie('t1', 's1199')).toBeDefined();
  });
});
