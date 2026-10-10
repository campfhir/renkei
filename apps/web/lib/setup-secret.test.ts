/**
 * The setup secret's contract: it comes from the environment and nowhere
 * else, a short or absent variable is no secret at all, and the comparison
 * is exact.
 */

import { setupSecretProblem, verifySetupSecret, SETUP_SECRET_MIN_CHARS } from './setup-secret';

const SECRET = 'correct-horse-battery-staple';

describe('setupSecretProblem', () => {
  it('reports an unset or blank variable', () => {
    expect(setupSecretProblem({})).toBe('unset');
    expect(setupSecretProblem({ SETUP_SECRET: '   ' })).toBe('unset');
  });

  it('refuses a short value as a secret', () => {
    expect(setupSecretProblem({ SETUP_SECRET: 'a'.repeat(SETUP_SECRET_MIN_CHARS - 1) })).toBe('short');
    expect(setupSecretProblem({ SETUP_SECRET: 'a'.repeat(SETUP_SECRET_MIN_CHARS) })).toBeNull();
  });
});

describe('verifySetupSecret', () => {
  it('accepts the configured value, trimmed', () => {
    expect(verifySetupSecret(SECRET, { SETUP_SECRET: SECRET })).toBe('ok');
    expect(verifySetupSecret(`  ${SECRET}\n`, { SETUP_SECRET: ` ${SECRET} ` })).toBe('ok');
  });

  it('tells a missing header from a wrong one', () => {
    expect(verifySetupSecret(null, { SETUP_SECRET: SECRET })).toBe('missing');
    expect(verifySetupSecret('', { SETUP_SECRET: SECRET })).toBe('missing');
    expect(verifySetupSecret('guess', { SETUP_SECRET: SECRET })).toBe('mismatch');
    expect(verifySetupSecret(SECRET.toUpperCase(), { SETUP_SECRET: SECRET })).toBe('mismatch');
  });

  it('matches nothing while the environment holds no usable secret', () => {
    expect(verifySetupSecret(SECRET, {})).toBe('unset');
    expect(verifySetupSecret('short', { SETUP_SECRET: 'short' })).toBe('short');
    expect(verifySetupSecret('', {})).toBe('unset');
  });
});
