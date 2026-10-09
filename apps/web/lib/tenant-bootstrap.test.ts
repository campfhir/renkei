import { sha256Hex } from '@renkei/crypto';
import {
  BOOTSTRAP_SECRET_TTL_MS,
  mintBootstrapSecret,
  verifyBootstrapSecret,
} from './tenant-bootstrap';

describe('tenant bootstrap secret', () => {
  it('mints a secret whose digest is what the row keeps, expiring in a day', () => {
    const now = new Date('2026-01-01T00:00:00Z');
    const minted = mintBootstrapSecret(now);
    expect(minted.secret.length).toBeGreaterThanOrEqual(32);
    expect(minted.hash).toBe(sha256Hex(minted.secret));
    expect(minted.expiresAt.getTime()).toBe(now.getTime() + BOOTSTRAP_SECRET_TTL_MS);
  });

  it('accepts the live secret and refuses everything else', () => {
    const minted = mintBootstrapSecret();
    const row = {
      bootstrap_secret_hash: minted.hash,
      bootstrap_secret_expires_at: minted.expiresAt,
    };
    expect(verifyBootstrapSecret(minted.secret, row)).toBe('ok');
    expect(verifyBootstrapSecret('not-it', row)).toBe('mismatch');
    expect(verifyBootstrapSecret(null, row)).toBe('missing');
    expect(verifyBootstrapSecret('', row)).toBe('missing');
  });

  it('refuses an expired secret even when it matches', () => {
    const minted = mintBootstrapSecret(new Date(Date.now() - 2 * BOOTSTRAP_SECRET_TTL_MS));
    const row = {
      bootstrap_secret_hash: minted.hash,
      bootstrap_secret_expires_at: minted.expiresAt,
    };
    expect(verifyBootstrapSecret(minted.secret, row)).toBe('expired');
  });

  it('reports a row that never had (or already spent) its secret distinctly', () => {
    const row = { bootstrap_secret_hash: null, bootstrap_secret_expires_at: null };
    expect(verifyBootstrapSecret('anything', row)).toBe('none-issued');
  });
});
