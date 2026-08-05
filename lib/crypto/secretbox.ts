/**
 * AES-256-GCM envelope for secrets held at rest (Atlassian access and refresh
 * tokens). Authenticated encryption is the point: a tampered ciphertext fails
 * to decrypt rather than yielding attacker-chosen plaintext.
 *
 * Wire format is `v1.<iv>.<tag>.<ciphertext>`, each part base64. The version
 * prefix exists so a future key-rotation or algorithm change can be detected
 * instead of silently misparsed.
 */

import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from 'node:crypto';
import { ok, err } from '@campfhir/safe-functions/helpers';
import type { Result } from '@campfhir/safe-functions/types';

const ALGORITHM = 'aes-256-gcm';
const VERSION = 'v1';
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;

export class DecryptionError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'DecryptionError';
  }
}

/**
 * Decodes and length-checks TOKEN_ENCRYPTION_KEY. Base64 decoding is lenient —
 * it silently drops invalid characters — so the byte-length check is what
 * actually catches a malformed or truncated key.
 */
export function parseEncryptionKey(encoded: string): Result<Buffer, 'INVALID_ENCRYPTION_KEY'> {
  const key = Buffer.from(encoded, 'base64');

  if (key.byteLength !== KEY_BYTES) {
    return err('INVALID_ENCRYPTION_KEY' as const, {
      message: `TOKEN_ENCRYPTION_KEY must decode to ${KEY_BYTES} bytes, got ${key.byteLength}. Generate one with: openssl rand -base64 32`,
    });
  }

  return ok(key);
}

export function encrypt(plaintext: string, key: Buffer): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);

  return [
    VERSION,
    iv.toString('base64'),
    cipher.getAuthTag().toString('base64'),
    ciphertext.toString('base64'),
  ].join('.');
}

export function decrypt(payload: string, key: Buffer): Result<string, 'DECRYPTION_ERROR'> {
  const parts = payload.split('.');

  if (parts.length !== 4) {
    return err('DECRYPTION_ERROR' as const, {
      message: 'malformed ciphertext: expected 4 dot-separated parts',
    });
  }

  const [version, ivPart, tagPart, ciphertextPart] = parts;

  if (version !== VERSION) {
    return err('DECRYPTION_ERROR' as const, {
      message: `unsupported ciphertext version: ${String(version)}`,
    });
  }
  if (ivPart === undefined || tagPart === undefined || ciphertextPart === undefined) {
    return err('DECRYPTION_ERROR' as const, {
      message: 'malformed ciphertext: missing part',
    });
  }

  const iv = Buffer.from(ivPart, 'base64');
  const tag = Buffer.from(tagPart, 'base64');

  if (iv.byteLength !== IV_BYTES) {
    return err('DECRYPTION_ERROR' as const, {
      message: `malformed ciphertext: iv must be ${IV_BYTES} bytes`,
    });
  }
  if (tag.byteLength !== TAG_BYTES) {
    return err('DECRYPTION_ERROR' as const, {
      message: `malformed ciphertext: auth tag must be ${TAG_BYTES} bytes`,
    });
  }

  try {
    const decipher = createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(tag);
    const decrypted = Buffer.concat([
      decipher.update(Buffer.from(ciphertextPart, 'base64')),
      decipher.final(),
    ]).toString('utf8');
    return ok(decrypted);
  } catch (cause) {
    // Wrong key or tampered payload both land here. Deliberately opaque: the
    // caller has no legitimate use for knowing which.
    return err('DECRYPTION_ERROR' as const, {
      message: 'token decryption failed (wrong key or tampered payload)',
      cause,
    });
  }
}

/** Constant-time comparison for OAuth `state` and other short secrets. */
export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');

  if (left.byteLength !== right.byteLength) {
    return false;
  }

  return timingSafeEqual(left, right);
}
