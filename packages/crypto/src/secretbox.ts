/**
 * AES-256-GCM envelope for secrets held at rest (Atlassian access and refresh
 * tokens). Authenticated encryption is the point: a tampered ciphertext fails
 * to decrypt rather than yielding attacker-chosen plaintext.
 *
 * Two wire formats, each part base64:
 *
 *   v1.<iv>.<tag>.<ciphertext>          one key, unnamed
 *   v2.<kid>.<iv>.<tag>.<ciphertext>    `kid` names the key: the first 8 hex
 *                                       characters of SHA-256(key bytes)
 *
 * The version prefix exists so a key rotation can be detected instead of
 * silently misparsed. A KEYRING (see `loadKeyring`) is the current key with
 * the previous ones behind it: `encrypt` under a keyring writes `v2` under
 * the current key; `decrypt` under a keyring opens `v2` by its kid and tries
 * every key of the ring, current first, on a `v1` — so rotation is "add the
 * new key in front, keep the old one behind it, rewrap, drop the old one"
 * (DEPLOYMENT.md, "Rotating TOKEN_ENCRYPTION_KEY"). A bare key (no ring)
 * still writes `v1`: the browser's secretbox (browser/webcrypto.ts) opens
 * `v1` only, and the per-user and resource keys it shares with the server
 * are never org keys and never rotate through a ring.
 */

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import { ok, err } from '@campfhir/safe-functions/helpers';
import type { Result } from '@campfhir/safe-functions/types';

const ALGORITHM = 'aes-256-gcm';
const VERSION_V1 = 'v1';
const VERSION_V2 = 'v2';
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KID_HEX_CHARS = 8;

/**
 * The previous keys ride on the current key's Buffer under this symbol, so a
 * keyring IS a Buffer: every `key: Buffer` signature between an env read and
 * `encrypt`/`decrypt` carries the ring through unchanged, and a Buffer that
 * never came from `loadKeyring` behaves exactly as before.
 */
const RING = Symbol.for('@renkei/crypto.keyring');

/** A 32-byte key, possibly carrying the previous keys of its ring (see `loadKeyring`). */
export type Keyring = Buffer & { readonly [RING]?: readonly Buffer[] };

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

/** The key's id as a `v2` envelope names it: the first 8 hex characters of SHA-256(key). */
export function keyId(key: Buffer): string {
  return createHash('sha256').update(key).digest('hex').slice(0, KID_HEX_CHARS);
}

/** The current key first, then the previous ones; a bare key is a ring of one. */
export function keyringKeys(key: Keyring): readonly Buffer[] {
  const previous = key[RING];
  return previous && previous.length > 0 ? [key, ...previous] : [key];
}

/** Whether the key came from `parseKeyring`/`loadKeyring` (and so writes `v2`). */
export function isKeyring(key: Keyring): boolean {
  return key[RING] !== undefined;
}

/**
 * `<current>,<previous>,...` — each a base64 32-byte key — into a keyring:
 * the first key, as a Buffer, with the rest behind it. A single key is a
 * ring of one. Any malformed entry fails the whole ring: a rotation that
 * silently dropped the old key would leave every row under it unreadable.
 */
export function parseKeyring(encoded: string): Result<Keyring, 'INVALID_ENCRYPTION_KEY'> {
  const parts = encoded
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length === 0) return parseEncryptionKey('');
  const keys: Buffer[] = [];
  for (const part of parts) {
    const parsed = parseEncryptionKey(part);
    if (!parsed.ok) return parsed;
    keys.push(parsed.val);
  }
  const current = keys[0]!;
  const previous = keys.slice(1);
  const ring: Keyring = Buffer.from(current);
  Object.defineProperty(ring, RING, {
    value: Object.freeze(previous),
    enumerable: false,
    writable: false,
  });
  return ok(ring);
}

/**
 * The deployment's keyring for one purpose, from the environment:
 * `<NAME>S` (comma-separated, current first, previous behind it) when set,
 * else `<NAME>` alone — so `loadKeyring('TOKEN_ENCRYPTION_KEY')` reads
 * TOKEN_ENCRYPTION_KEYS or TOKEN_ENCRYPTION_KEY, and a deployment with one
 * key and no rotation under way changes nothing. The same error as
 * `parseEncryptionKey` when neither is set or either is malformed.
 */
export function loadKeyring(
  name: string,
  env: NodeJS.ProcessEnv = process.env
): Result<Keyring, 'INVALID_ENCRYPTION_KEY'> {
  const encoded = env[`${name}S`]?.trim() || env[name]?.trim() || '';
  const ring = parseKeyring(encoded);
  if (!ring.ok) {
    return err('INVALID_ENCRYPTION_KEY' as const, {
      message: `${name}S / ${name}: ${ring.err.message?.replace('TOKEN_ENCRYPTION_KEY', 'each key') ?? 'malformed'}`,
    });
  }
  return ring;
}

/** Which of the ring's keys sealed a value: a `v2` envelope's kid, or null for `v1` (or anything else). */
export function envelopeKeyId(payload: string): string | null {
  const parts = payload.split('.');
  if (parts.length === 5 && parts[0] === VERSION_V2 && parts[1]) return parts[1];
  return null;
}

export function encrypt(plaintext: string, key: Keyring): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tail = [
    iv.toString('base64'),
    cipher.getAuthTag().toString('base64'),
    ciphertext.toString('base64'),
  ];
  return isKeyring(key)
    ? [VERSION_V2, keyId(key), ...tail].join('.')
    : [VERSION_V1, ...tail].join('.');
}

function open(
  key: Buffer,
  ivPart: string,
  tagPart: string,
  ciphertextPart: string
): Result<string, 'DECRYPTION_ERROR'> {
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

export function decrypt(payload: string, key: Keyring): Result<string, 'DECRYPTION_ERROR'> {
  const parts = payload.split('.');
  const version = parts[0];

  if (version === VERSION_V2) {
    if (parts.length !== 5) {
      return err('DECRYPTION_ERROR' as const, {
        message: 'malformed ciphertext: expected 5 dot-separated parts',
      });
    }
    const [, kid, ivPart, tagPart, ciphertextPart] = parts;
    if (!kid || ivPart === undefined || tagPart === undefined || ciphertextPart === undefined) {
      return err('DECRYPTION_ERROR' as const, {
        message: 'malformed ciphertext: missing part',
      });
    }
    const named = keyringKeys(key).find((candidate) => keyId(candidate) === kid);
    if (!named) {
      return err('DECRYPTION_ERROR' as const, {
        message: `no key with id ${kid} in the ring (sealed under a key this deployment no longer holds — a rotation dropped the previous key before rewrapping?)`,
      });
    }
    return open(named, ivPart, tagPart, ciphertextPart);
  }

  if (parts.length !== 4) {
    return err('DECRYPTION_ERROR' as const, {
      message: 'malformed ciphertext: expected 4 dot-separated parts',
    });
  }

  const [, ivPart, tagPart, ciphertextPart] = parts;

  if (version !== VERSION_V1) {
    return err('DECRYPTION_ERROR' as const, {
      message: `unsupported ciphertext version: ${String(version)}`,
    });
  }
  if (ivPart === undefined || tagPart === undefined || ciphertextPart === undefined) {
    return err('DECRYPTION_ERROR' as const, {
      message: 'malformed ciphertext: missing part',
    });
  }

  // A v1 envelope names no key: the current one first, then each previous
  // key of the ring. GCM's tag makes a wrong key a clean failure, never a
  // wrong plaintext, so trying them in turn is safe.
  let last: Result<string, 'DECRYPTION_ERROR'> | null = null;
  for (const candidate of keyringKeys(key)) {
    last = open(candidate, ivPart, tagPart, ciphertextPart);
    if (last.ok) return last;
  }
  return last ?? err('DECRYPTION_ERROR' as const, { message: 'no key' });
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
