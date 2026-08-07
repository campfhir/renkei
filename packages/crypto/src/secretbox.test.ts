import { encrypt, decrypt, parseEncryptionKey } from './secretbox';
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
