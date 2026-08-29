import {
  ONBASE_SESSION_COOKIE,
  clearSessions,
  forgetSession,
  hasOnBaseSession,
  parseSetCookies,
  rememberSession,
  sessionCookie,
  sessionCount,
} from './sessions';

const SET = (value: string) =>
  `${ONBASE_SESSION_COOKIE}=${value}; path=/; secure; HttpOnly; SameSite=Lax`;

beforeEach(() => clearSessions());

describe('parseSetCookies', () => {
  it('takes the name=value pairs and drops the attributes', () => {
    expect(parseSetCookies([SET('abc123')])).toEqual(new Map([[ONBASE_SESSION_COOKIE, 'abc123']]));
  });

  it('keeps EVERY cookie, not just the OnBase one', () => {
    // The load balancer's cookie is what pins a request to the node holding
    // the session; dropping it was the bug this replaced.
    expect(parseSetCookies([SET('abc123'), 'FB_LB=node-7; path=/'])).toEqual(
      new Map([
        [ONBASE_SESSION_COOKIE, 'abc123'],
        ['FB_LB', 'node-7'],
      ])
    );
  });

  it('survives an Expires date, whose comma looks like a cookie separator', () => {
    expect(
      parseSetCookies([`x=1; Expires=Wed, 21 Oct 2026 07:28:00 GMT, ${SET('abc123')}`])
    ).toEqual(
      new Map([
        ['x', '1'],
        [ONBASE_SESSION_COOKIE, 'abc123'],
      ])
    );
  });

  it('finds nothing in an empty set', () => {
    expect(parseSetCookies([]).size).toBe(0);
  });
});

describe('session reuse', () => {
  it('gives back what it stored, so the next call reuses the session', () => {
    rememberSession('t1', 's1', [SET('abc')]);
    expect(sessionCookie('t1', 's1')).toBe(`${ONBASE_SESSION_COOKIE}=abc`);
  });

  it('sends both cookies once a balancer is in play', () => {
    rememberSession('t1', 's1', [SET('abc'), 'FB_LB=node-7; path=/']);
    const header = sessionCookie('t1', 's1') ?? '';
    expect(header).toContain(`${ONBASE_SESSION_COOKIE}=abc`);
    expect(header).toContain('FB_LB=node-7');
  });

  it('renews the balancer cookie per response while the session holds still', () => {
    // Opposite lifecycles: FB_LB is reissued on EVERY response, the OnBase
    // session cookie keeps one value. A response carrying only the balancer
    // cookie must not lose the session.
    rememberSession('t1', 's1', [SET('abc'), 'FB_LB=node-7; path=/']);
    rememberSession('t1', 's1', ['FB_LB=node-9; path=/']);

    const header = sessionCookie('t1', 's1') ?? '';
    expect(header).toContain(`${ONBASE_SESSION_COOKIE}=abc`);
    expect(header).toContain('FB_LB=node-9');
    expect(header).not.toContain('node-7');
  });

  it('knows whether an OnBase session is actually held', () => {
    rememberSession('t1', 's1', ['FB_LB=node-7; path=/']);
    // A balancer cookie alone is routing, not a session — disconnecting on it
    // would make the API open a session just to close it.
    expect(hasOnBaseSession('t1', 's1')).toBe(false);
    rememberSession('t1', 's1', [SET('abc')]);
    expect(hasOnBaseSession('t1', 's1')).toBe(true);
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
