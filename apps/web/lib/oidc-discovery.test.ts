import { oidcDiscoveryUrl } from './oidc-discovery';

describe('oidcDiscoveryUrl', () => {
  it('appends to a path-less issuer', () => {
    expect(oidcDiscoveryUrl('https://idp.example.com')).toBe(
      'https://idp.example.com/.well-known/openid-configuration'
    );
  });

  it('preserves an issuer path — the bug this helper exists to prevent', () => {
    expect(oidcDiscoveryUrl('https://login.microsoftonline.com/abc-123/v2.0')).toBe(
      'https://login.microsoftonline.com/abc-123/v2.0/.well-known/openid-configuration'
    );
  });

  it('does not double a trailing slash', () => {
    expect(oidcDiscoveryUrl('https://idp.example.com/realm/')).toBe(
      'https://idp.example.com/realm/.well-known/openid-configuration'
    );
  });
});
