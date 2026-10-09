import {
  describeRedirectTarget,
  isLoopbackHost,
  redirectUriMatches,
  redirectUriProblem,
} from './oauth-redirect-uri';

describe('a redirect URI a client may register', () => {
  it('accepts https anywhere, http on the loopback, and a native app scheme', () => {
    for (const ok of [
      'https://claude.ai/api/mcp/auth_callback',
      'https://example.com/cb?x=1',
      'http://localhost/callback',
      'http://localhost:52341/callback',
      'http://127.0.0.1:8080/cb',
      'http://[::1]:9000/cb',
      'cursor://anysphere.cursor-mcp/oauth/callback',
      'vscode://redhat.vscode-mcp/authorize',
      'com.example.app:/oauth2redirect',
    ]) {
      expect(redirectUriProblem(ok)).toBeNull();
    }
  });

  it('refuses plain http off the loopback, executable schemes, fragments and credentials', () => {
    expect(redirectUriProblem('http://attacker.example/cb')).toMatch(/must use https/);
    expect(redirectUriProblem('http://localhost.attacker.example/cb')).toMatch(/must use https/);
    expect(redirectUriProblem('http://127.0.0.2/cb')).toMatch(/must use https/);
    expect(redirectUriProblem('javascript:alert(1)')).toMatch(/javascript: scheme/);
    expect(redirectUriProblem('data:text/html,hi')).toMatch(/data: scheme/);
    expect(redirectUriProblem('https://example.com/cb#frag')).toMatch(/fragment/);
    expect(redirectUriProblem('https://user:pw@example.com/cb')).toMatch(/credentials/);
    expect(redirectUriProblem('not a url')).toMatch(/absolute URL/);
    expect(redirectUriProblem(42)).toMatch(/string/);
    expect(redirectUriProblem('')).toMatch(/string/);
    expect(redirectUriProblem(`https://example.com/${'a'.repeat(2048)}`)).toMatch(/2048/);
  });

  it('knows the loopback by name', () => {
    expect(isLoopbackHost('localhost')).toBe(true);
    expect(isLoopbackHost('LOCALHOST')).toBe(true);
    expect(isLoopbackHost('[::1]')).toBe(true);
    expect(isLoopbackHost('127.0.0.1')).toBe(true);
    expect(isLoopbackHost('example.com')).toBe(false);
  });
});

describe('matching a presented redirect URI against the registration', () => {
  const registered = ['https://claude.ai/api/mcp/auth_callback', 'http://127.0.0.1/callback'];

  it('matches exactly, and ignores the port only for loopback http', () => {
    expect(redirectUriMatches(registered, 'https://claude.ai/api/mcp/auth_callback')).toBe(true);
    expect(redirectUriMatches(registered, 'http://127.0.0.1:61234/callback')).toBe(true);
    expect(redirectUriMatches(registered, 'http://127.0.0.1/callback')).toBe(true);
    expect(redirectUriMatches(registered, 'https://claude.ai:8443/api/mcp/auth_callback')).toBe(
      false
    );
    expect(redirectUriMatches(registered, 'http://127.0.0.1:61234/other')).toBe(false);
    expect(redirectUriMatches(registered, 'http://localhost:61234/callback')).toBe(false);
    expect(redirectUriMatches(registered, 'https://claude.ai/api/mcp/auth_callback?x=1')).toBe(
      false
    );
    expect(redirectUriMatches(registered, 'nonsense')).toBe(false);
  });
});

describe('describing where the code goes', () => {
  it('names a host, or says the app is local', () => {
    expect(describeRedirectTarget('https://claude.ai/api/mcp/auth_callback')).toBe('claude.ai');
    expect(describeRedirectTarget('http://127.0.0.1:5000/cb')).toBe(
      'an application running on this computer'
    );
    expect(describeRedirectTarget('cursor://x/cb')).toBe('the cursor application on this computer');
  });
});
