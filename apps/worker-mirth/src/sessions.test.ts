import { forgetSession, rememberSession, resetSessions, sessionCookie } from './sessions';

beforeEach(() => resetSessions());

describe('session jar', () => {
  it('holds nothing until a response sets a cookie', () => {
    expect(sessionCookie('i', 'alice')).toBeUndefined();
    rememberSession('i', 'alice', []);
    expect(sessionCookie('i', 'alice')).toBeUndefined();
  });

  it('keeps every cookie the server set and sends them all back', () => {
    rememberSession('i', 'alice', [
      'JSESSIONID=abc123; Path=/api; Secure; HttpOnly',
      'LB=node2; Path=/',
    ]);
    expect(sessionCookie('i', 'alice')).toBe('JSESSIONID=abc123; LB=node2');
  });

  it('updates a reissued cookie in place and honours deletions', () => {
    rememberSession('i', 'alice', ['JSESSIONID=abc; Path=/', 'LB=node1']);
    rememberSession('i', 'alice', ['LB=node2']);
    expect(sessionCookie('i', 'alice')).toBe('JSESSIONID=abc; LB=node2');
    rememberSession('i', 'alice', ['LB=; Max-Age=0']);
    expect(sessionCookie('i', 'alice')).toBe('JSESSIONID=abc');
  });

  it('never crosses people or instances', () => {
    rememberSession('dev', 'alice', ['JSESSIONID=a']);
    rememberSession('prod', 'alice', ['JSESSIONID=p']);
    rememberSession('dev', 'bob', ['JSESSIONID=b']);
    expect(sessionCookie('dev', 'alice')).toBe('JSESSIONID=a');
    expect(sessionCookie('prod', 'alice')).toBe('JSESSIONID=p');
    expect(sessionCookie('dev', 'bob')).toBe('JSESSIONID=b');
  });

  it('expires an idle jar and forgets on demand', () => {
    rememberSession('i', 'alice', ['JSESSIONID=abc'], 1_000);
    expect(sessionCookie('i', 'alice', 1_000 + 9 * 60_000)).toBe('JSESSIONID=abc');
    expect(sessionCookie('i', 'alice', 1_000 + 11 * 60_000)).toBeUndefined();
    rememberSession('i', 'alice', ['JSESSIONID=abc']);
    forgetSession('i', 'alice');
    expect(sessionCookie('i', 'alice')).toBeUndefined();
  });
});
