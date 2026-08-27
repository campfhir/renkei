import { oidcDiscoveryUrl, parseDiscoveryDocument } from './discovery';

describe('oidcDiscoveryUrl', () => {
  it('appends the well-known path to a bare origin', () => {
    expect(oidcDiscoveryUrl('https://idp.corp.local')).toEqual({
      ok: true,
      val: 'https://idp.corp.local/.well-known/openid-configuration',
    });
  });

  it('keeps an issuer path component and strips trailing slashes', () => {
    expect(oidcDiscoveryUrl('https://idp.corp.local/identity/')).toEqual({
      ok: true,
      val: 'https://idp.corp.local/identity/.well-known/openid-configuration',
    });
  });

  it('rejects non-http schemes and non-URLs', () => {
    expect(oidcDiscoveryUrl('ftp://idp').ok).toBe(false);
    expect(oidcDiscoveryUrl('not a url').ok).toBe(false);
  });
});

describe('parseDiscoveryDocument', () => {
  const doc = {
    issuer: 'https://idp.corp.local/identity',
    authorization_endpoint: 'https://idp.corp.local/identity/connect/authorize',
    token_endpoint: 'https://idp.corp.local/identity/connect/token',
    revocation_endpoint: 'https://idp.corp.local/identity/connect/revocation',
  };

  it('extracts the endpoints Renkei uses', () => {
    const result = parseDiscoveryDocument(doc);
    expect(result).toEqual({
      ok: true,
      val: {
        issuer: doc.issuer,
        authorizationEndpoint: doc.authorization_endpoint,
        tokenEndpoint: doc.token_endpoint,
        revocationEndpoint: doc.revocation_endpoint,
      },
    });
  });

  it('tolerates a missing revocation endpoint', () => {
    const { revocation_endpoint: _dropped, ...rest } = doc;
    const result = parseDiscoveryDocument(rest);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.val.revocationEndpoint).toBeUndefined();
  });

  it('refuses documents missing required endpoints or with junk URLs', () => {
    expect(parseDiscoveryDocument({ issuer: 'x' }).ok).toBe(false);
    expect(parseDiscoveryDocument(null).ok).toBe(false);
    expect(
      parseDiscoveryDocument({ ...doc, token_endpoint: 'javascript:alert(1)' }).ok
    ).toBe(false);
  });
});
