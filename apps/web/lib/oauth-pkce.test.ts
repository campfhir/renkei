import { randomBytes } from 'node:crypto';
import {
  codeChallengeProblem,
  computeS256,
  isWellFormedVerifier,
  verifierMatchesChallenge,
} from './oauth-pkce';

describe('PKCE parameters', () => {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = computeS256(verifier);

  it('accepts only a well-formed S256 challenge', () => {
    expect(codeChallengeProblem(challenge, 'S256')).toBeNull();
    expect(codeChallengeProblem(null, 'S256')).toMatch(/required/);
    expect(codeChallengeProblem(challenge, null)).toMatch(/must be S256/);
    expect(codeChallengeProblem(challenge, 'plain')).toMatch(/must be S256/);
    expect(codeChallengeProblem('too-short', 'S256')).toMatch(/43 characters/);
    expect(codeChallengeProblem(`${challenge}=`, 'S256')).toMatch(/43 characters/);
  });

  it('checks the verifier shape before hashing it', () => {
    expect(isWellFormedVerifier(verifier)).toBe(true);
    expect(isWellFormedVerifier('x'.repeat(43))).toBe(true);
    expect(isWellFormedVerifier('x'.repeat(128))).toBe(true);
    expect(isWellFormedVerifier('x'.repeat(42))).toBe(false);
    expect(isWellFormedVerifier('x'.repeat(129))).toBe(false);
    expect(isWellFormedVerifier(`${'x'.repeat(43)}+`)).toBe(false);
    expect(isWellFormedVerifier(undefined)).toBe(false);
  });

  it('matches the verifier to its challenge and nothing else', () => {
    expect(verifierMatchesChallenge(verifier, challenge)).toBe(true);
    expect(verifierMatchesChallenge(`${verifier}a`, challenge)).toBe(false);
    expect(verifierMatchesChallenge(verifier, challenge.slice(0, 42))).toBe(false);
    // The same value computed the long way round (RFC 7636 appendix B).
    expect(computeS256('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe(
      'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM'
    );
  });
});
