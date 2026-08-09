import { scopesFromAccessToken } from './token-claims';

function jwtWithPayload(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${header}.${body}.fakesignature`;
}

describe('scopesFromAccessToken', () => {
  it('returns null for opaque (non-JWT) tokens', () => {
    expect(scopesFromAccessToken('ZTk0Y2FkOWQtNmFiNy00OWY0')).toBeNull();
  });

  it('returns null for a JWT whose payload is not decodable JSON', () => {
    expect(scopesFromAccessToken('aGVhZGVy.%%%%.c2ln')).toBeNull();
  });

  it('splits a space-separated scope claim', () => {
    const token = jwtWithPayload({
      sub: 'abc',
      scope: 'read:ops-alert:jira-service-management offline_access',
    });
    expect(scopesFromAccessToken(token)).toEqual([
      'read:ops-alert:jira-service-management',
      'offline_access',
    ]);
  });

  it('accepts an array-valued scopes claim', () => {
    const token = jwtWithPayload({ scopes: ['a', 'b'] });
    expect(scopesFromAccessToken(token)).toEqual(['a', 'b']);
  });

  it('finds a provider-namespaced scope claim', () => {
    const token = jwtWithPayload({ 'https://id.atlassian.com/scopes': ['x:y'] });
    expect(scopesFromAccessToken(token)).toEqual(['x:y']);
  });

  it('returns null when no scope-shaped claim exists', () => {
    const token = jwtWithPayload({ sub: 'abc', aud: 'api.atlassian.com' });
    expect(scopesFromAccessToken(token)).toBeNull();
  });

  it('ignores an empty scope string rather than returning []', () => {
    const token = jwtWithPayload({ scope: '   ' });
    expect(scopesFromAccessToken(token)).toBeNull();
  });

  it('ignores a mixed-type array under a scope key', () => {
    const token = jwtWithPayload({ scopes: ['a', 42] });
    expect(scopesFromAccessToken(token)).toBeNull();
  });
});
