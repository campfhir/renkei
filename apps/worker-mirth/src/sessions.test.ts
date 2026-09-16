import { forgetSession, rememberSession, resetSessions, sessionCookie } from './sessions';

beforeEach(() => resetSessions());

describe('session jar', () => {
  it('holds nothing until a response sets a cookie', () => {
    expect(sessionCookie('t', 'i', 'alice')).toBeUndefined();
    rememberSession('t', 'i', 'alice', []);
    expect(sessionCookie('t', 'i', 'alice')).toBeUndefined();
  });

  it('keeps every cookie the server set and sends them all back', () => {
    rememberSession('t', 'i', 'alice', [
      'JSESSIONID=abc123; Path=/api; Secure; HttpOnly',
      'LB=node2; Path=/',
    ]);
    expect(sessionCookie('t', 'i', 'alice')).toBe('JSESSIONID=abc123; LB=node2');
  });

  it('updates a reissued cookie in place and honours deletions', () => {
    rememberSession('t', 'i', 'alice', ['JSESSIONID=abc; Path=/', 'LB=node1']);
    rememberSession('t', 'i', 'alice', ['LB=node2']);
    expect(sessionCookie('t', 'i', 'alice')).toBe('JSESSIONID=abc; LB=node2');
    rememberSession('t', 'i', 'alice', ['LB=; Max-Age=0']);
    expect(sessionCookie('t', 'i', 'alice')).toBe('JSESSIONID=abc');
  });

  it('never crosses people or instances', () => {
    rememberSession('t', 'dev', 'alice', ['JSESSIONID=a']);
    rememberSession('t', 'prod', 'alice', ['JSESSIONID=p']);
    rememberSession('t', 'dev', 'bob', ['JSESSIONID=b']);
    expect(sessionCookie('t', 'dev', 'alice')).toBe('JSESSIONID=a');
    expect(sessionCookie('t', 'prod', 'alice')).toBe('JSESSIONID=p');
    expect(sessionCookie('t', 'dev', 'bob')).toBe('JSESSIONID=b');
    expect(sessionCookie('other', 'dev', 'alice')).toBeUndefined();
  });

  it('expires an idle jar and forgets on demand', () => {
    rememberSession('t', 'i', 'alice', ['JSESSIONID=abc'], 1_000);
    expect(sessionCookie('t', 'i', 'alice', 1_000 + 9 * 60_000)).toBe('JSESSIONID=abc');
    expect(sessionCookie('t', 'i', 'alice', 1_000 + 11 * 60_000)).toBeUndefined();
    rememberSession('t', 'i', 'alice', ['JSESSIONID=abc']);
    forgetSession('t', 'i', 'alice');
    expect(sessionCookie('t', 'i', 'alice')).toBeUndefined();
  });
});
