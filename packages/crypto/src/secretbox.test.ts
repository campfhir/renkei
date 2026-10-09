import {
  encrypt,
  decrypt,
  parseEncryptionKey,
  parseKeyring,
  loadKeyring,
  keyringKeys,
  keyId,
  isKeyring,
  envelopeKeyId,
} from './secretbox';
import { randomBytes } from 'crypto';

describe('secretbox encryption', () => {
  const generateValidKey = () => {
    return randomBytes(32).toString('base64');
  };

  it('should encrypt and decrypt a token successfully', () => {
    const keyEnv = generateValidKey();
    const keyResult = parseEncryptionKey(keyEnv);
    expect(keyResult.ok).toBe(true);

    const token =
      'eyJraWQiOiJhdXRoLmF0bGFzc2lhbi5jb20iLCJhbGciOiJSUzI1NiJ9.sample_token_payload.signature';
    const key = keyResult.ok ? keyResult.val : Buffer.alloc(0);

    const encrypted = encrypt(token, key);
    expect(encrypted).toMatch(/^v1\./);
    expect(encrypted).not.toContain(token);

    const decrypted = decrypt(encrypted, key);
    expect(decrypted.ok).toBe(true);
    if (decrypted.ok) {
      expect(decrypted.val).toBe(token);
    }
  });

  it('should handle long tokens', () => {
    const keyEnv = generateValidKey();
    const keyResult = parseEncryptionKey(keyEnv);
    expect(keyResult.ok).toBe(true);

    const longToken = 'x'.repeat(10000);
    const key = keyResult.ok ? keyResult.val : Buffer.alloc(0);

    const encrypted = encrypt(longToken, key);
    const decrypted = decrypt(encrypted, key);

    expect(decrypted.ok).toBe(true);
    if (decrypted.ok) {
      expect(decrypted.val).toBe(longToken);
    }
  });

  it('should fail to decrypt with wrong key', () => {
    const key1Env = generateValidKey();
    const key2Env = generateValidKey();

    const key1Result = parseEncryptionKey(key1Env);
    const key2Result = parseEncryptionKey(key2Env);
    expect(key1Result.ok).toBe(true);
    expect(key2Result.ok).toBe(true);

    const token = 'test_token_123';
    const key1 = key1Result.ok ? key1Result.val : Buffer.alloc(0);
    const key2 = key2Result.ok ? key2Result.val : Buffer.alloc(0);

    const encrypted = encrypt(token, key1);
    const decrypted = decrypt(encrypted, key2);

    expect(decrypted.ok).toBe(false);
    if (!decrypted.ok) {
      expect(decrypted.err.type).toBe('DECRYPTION_ERROR');
    }
  });

  it('should reject invalid encryption key', () => {
    const result = parseEncryptionKey('invalid-key');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.err.type).toBe('INVALID_ENCRYPTION_KEY');
    }
  });

  it('should reject malformed ciphertext', () => {
    const keyEnv = generateValidKey();
    const keyResult = parseEncryptionKey(keyEnv);
    expect(keyResult.ok).toBe(true);

    const key = keyResult.ok ? keyResult.val : Buffer.alloc(0);

    // Too few parts
    const result1 = decrypt('v1.invalid.ciphertext', key);
    expect(result1.ok).toBe(false);

    // Wrong version
    const result2 = decrypt('v2.part.part.part', key);
    expect(result2.ok).toBe(false);

    // Wrong IV size
    const result3 = decrypt('v1.aW52YWxpZA==.aW52YWxpZA==.Y2lwaGVydGV4dA==', key);
    expect(result3.ok).toBe(false);
  });

  it('should handle special characters in token', () => {
    const keyEnv = generateValidKey();
    const keyResult = parseEncryptionKey(keyEnv);
    expect(keyResult.ok).toBe(true);

    const specialToken = 'token_with_!@#$%^&*()_+-=[]{}|;:,.<>?/~`';
    const key = keyResult.ok ? keyResult.val : Buffer.alloc(0);

    const encrypted = encrypt(specialToken, key);
    const decrypted = decrypt(encrypted, key);

    expect(decrypted.ok).toBe(true);
    if (decrypted.ok) {
      expect(decrypted.val).toBe(specialToken);
    }
  });

  it('should handle unicode characters', () => {
    const keyEnv = generateValidKey();
    const keyResult = parseEncryptionKey(keyEnv);
    expect(keyResult.ok).toBe(true);

    const unicodeToken = 'token_with_unicode_😀_🎉_日本語';
    const key = keyResult.ok ? keyResult.val : Buffer.alloc(0);

    const encrypted = encrypt(unicodeToken, key);
    const decrypted = decrypt(encrypted, key);

    expect(decrypted.ok).toBe(true);
    if (decrypted.ok) {
      expect(decrypted.val).toBe(unicodeToken);
    }
  });

  it('should produce different ciphertexts for same plaintext (due to random IV)', () => {
    const keyEnv = generateValidKey();
    const keyResult = parseEncryptionKey(keyEnv);
    expect(keyResult.ok).toBe(true);

    const token = 'same_token';
    const key = keyResult.ok ? keyResult.val : Buffer.alloc(0);

    const encrypted1 = encrypt(token, key);
    const encrypted2 = encrypt(token, key);

    expect(encrypted1).not.toBe(encrypted2);

    // But both should decrypt to the same plaintext
    const decrypted1 = decrypt(encrypted1, key);
    const decrypted2 = decrypt(encrypted2, key);

    expect(decrypted1.ok).toBe(true);
    expect(decrypted2.ok).toBe(true);
    if (decrypted1.ok && decrypted2.ok) {
      expect(decrypted1.val).toBe(token);
      expect(decrypted2.val).toBe(token);
    }
  });
});

describe('keyrings (rotation)', () => {
  const fresh = () => randomBytes(32).toString('base64');

  it('a bare key still writes v1; a ring of one writes v2 naming its key', () => {
    const encoded = fresh();
    const bare = parseEncryptionKey(encoded);
    const ring = parseKeyring(encoded);
    expect(bare.ok && ring.ok).toBe(true);
    if (!bare.ok || !ring.ok) return;
    expect(isKeyring(bare.val)).toBe(false);
    expect(isKeyring(ring.val)).toBe(true);
    expect(encrypt('x', bare.val)).toMatch(/^v1\./);
    const sealed = encrypt('x', ring.val);
    expect(sealed).toMatch(/^v2\.[0-9a-f]{8}\./);
    expect(envelopeKeyId(sealed)).toBe(keyId(ring.val));
    expect(envelopeKeyId(encrypt('x', bare.val))).toBeNull();
    // Same bytes, so each opens what the other wrote.
    expect(decrypt(sealed, bare.val)).toEqual({ ok: true, val: 'x' });
    expect(decrypt(encrypt('x', bare.val), ring.val)).toEqual({ ok: true, val: 'x' });
  });

  it('round-trips v2 and keeps the previous key behind the current one', () => {
    const oldKey = fresh();
    const newKey = fresh();
    const before = parseKeyring(oldKey);
    const after = parseKeyring(`${newKey},${oldKey}`);
    expect(before.ok && after.ok).toBe(true);
    if (!before.ok || !after.ok) return;
    expect(keyringKeys(after.val)).toHaveLength(2);
    expect(keyId(after.val)).not.toBe(keyId(before.val));

    const underOld = encrypt('token', before.val);
    const rewrapped = encrypt('token', after.val);
    expect(envelopeKeyId(underOld)).toBe(keyId(before.val));
    expect(envelopeKeyId(rewrapped)).toBe(keyId(after.val));
    // The new ring opens both: v2 by kid.
    expect(decrypt(underOld, after.val)).toEqual({ ok: true, val: 'token' });
    expect(decrypt(rewrapped, after.val)).toEqual({ ok: true, val: 'token' });
    // The old ring alone cannot open what the new key sealed.
    const stale = decrypt(rewrapped, before.val);
    expect(stale.ok).toBe(false);
    if (!stale.ok) expect(stale.err.message).toContain('no key with id');
  });

  it('opens a v1 value under a previous key of the ring (current tried first)', () => {
    const oldKey = fresh();
    const newKey = fresh();
    const bareOld = parseEncryptionKey(oldKey);
    const ring = parseKeyring(`${newKey},${oldKey}`);
    expect(bareOld.ok && ring.ok).toBe(true);
    if (!bareOld.ok || !ring.ok) return;
    const legacy = encrypt('legacy', bareOld.val);
    expect(legacy).toMatch(/^v1\./);
    expect(decrypt(legacy, ring.val)).toEqual({ ok: true, val: 'legacy' });
    // A v1 under a key that is in no ring stays closed.
    const other = parseKeyring(fresh());
    if (!other.ok) return;
    expect(decrypt(legacy, other.val).ok).toBe(false);
  });

  it('refuses a v2 envelope whose kid matches no key, and a malformed v2', () => {
    const ring = parseKeyring(fresh());
    expect(ring.ok).toBe(true);
    if (!ring.ok) return;
    const sealed = encrypt('x', ring.val);
    const swapped = sealed.replace(/^v2\.[0-9a-f]{8}\./, 'v2.deadbeef.');
    const mismatch = decrypt(swapped, ring.val);
    expect(mismatch.ok).toBe(false);
    if (!mismatch.ok) {
      expect(mismatch.err.type).toBe('DECRYPTION_ERROR');
      expect(mismatch.err.message).toContain('deadbeef');
    }
    expect(decrypt('v2.a.b.c', ring.val).ok).toBe(false);
    expect(decrypt('v2.a.b.c.d.e', ring.val).ok).toBe(false);
  });

  it('parses a ring from the environment: <NAME>S first, <NAME> alone otherwise', () => {
    const a = fresh();
    const b = fresh();
    const plural = loadKeyring('TOKEN_ENCRYPTION_KEY', {
      TOKEN_ENCRYPTION_KEYS: ` ${a}, ${b} `,
      TOKEN_ENCRYPTION_KEY: fresh(),
    });
    expect(plural.ok).toBe(true);
    if (plural.ok) {
      expect(keyringKeys(plural.val).map((k) => k.toString('base64'))).toEqual([a, b]);
    }
    const singular = loadKeyring('LOG_ENCRYPTION_KEY', { LOG_ENCRYPTION_KEY: a });
    expect(singular.ok).toBe(true);
    if (singular.ok) {
      expect(keyringKeys(singular.val)).toHaveLength(1);
      expect(isKeyring(singular.val)).toBe(true);
    }
    const missing = loadKeyring('TOKEN_ENCRYPTION_KEY', {});
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.err.type).toBe('INVALID_ENCRYPTION_KEY');
    // One bad entry fails the whole ring rather than dropping it.
    const partial = loadKeyring('TOKEN_ENCRYPTION_KEY', {
      TOKEN_ENCRYPTION_KEYS: `${a},not-a-key`,
    });
    expect(partial.ok).toBe(false);
  });
});
