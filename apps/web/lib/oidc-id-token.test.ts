import { verifyIdTokenClaims } from './oidc-id-token';

const EXPECTED = {
  issuer: 'https://idp.example.com',
  clientId: 'client-1',
  nonce: 'nonce-abc',
};

// A fixed "now" so exp math is deterministic.
const NOW = 1_000_000_000;

function claims(overrides: Record<string, unknown> = {}) {
  return {
    sub: 'user-1',
    iss: EXPECTED.issuer,
    aud: EXPECTED.clientId,
    nonce: EXPECTED.nonce,
    exp: NOW + 300,
    ...overrides,
  };
}

describe('verifyIdTokenClaims', () => {
  it('accepts a well-formed token', () => {
    expect(verifyIdTokenClaims(claims(), EXPECTED, NOW)).toBeNull();
  });

  it('rejects a null token', () => {
    expect(verifyIdTokenClaims(null, EXPECTED, NOW)).toMatch(/missing/);
  });

  it('rejects a missing or mismatched nonce', () => {
    expect(verifyIdTokenClaims(claims({ nonce: undefined }), EXPECTED, NOW)).toMatch(/no nonce/);
    expect(verifyIdTokenClaims(claims({ nonce: 'other' }), EXPECTED, NOW)).toMatch(/nonce mismatch/);
  });

  it('rejects a mismatched issuer', () => {
    expect(verifyIdTokenClaims(claims({ iss: 'https://evil.example.com' }), EXPECTED, NOW)).toMatch(
      /issuer mismatch/
    );
  });

  it('rejects a token whose audience is not this client', () => {
    expect(verifyIdTokenClaims(claims({ aud: 'other-client' }), EXPECTED, NOW)).toMatch(
      /audience does not include/
    );
    expect(verifyIdTokenClaims(claims({ aud: [] }), EXPECTED, NOW)).toMatch(/no audience/);
  });

  it('accepts an array audience that includes this client', () => {
    expect(
      verifyIdTokenClaims(claims({ aud: ['client-1', 'other'], azp: 'client-1' }), EXPECTED, NOW)
    ).toBeNull();
  });

  it('requires azp when there are multiple audiences', () => {
    expect(verifyIdTokenClaims(claims({ aud: ['client-1', 'other'] }), EXPECTED, NOW)).toMatch(
      /azp/
    );
    expect(
      verifyIdTokenClaims(claims({ aud: ['client-1', 'other'], azp: 'other' }), EXPECTED, NOW)
    ).toMatch(/azp/);
  });

  it('rejects an expired token but tolerates small clock skew', () => {
    expect(verifyIdTokenClaims(claims({ exp: NOW - 3600 }), EXPECTED, NOW)).toMatch(/expired/);
    // Within the leeway window it is still accepted.
    expect(verifyIdTokenClaims(claims({ exp: NOW - 30 }), EXPECTED, NOW)).toBeNull();
  });

  it('rejects a token with no expiry', () => {
    expect(verifyIdTokenClaims(claims({ exp: undefined }), EXPECTED, NOW)).toMatch(/no expiry/);
  });
});
