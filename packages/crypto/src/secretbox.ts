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
 *   v3.<kid>.<iv>.<tag>.<ciphertext>    as v2, and the GCM tag also covers
 *                                       ASSOCIATED DATA (purpose and, where
 *                                       known, row id) that is not stored: a
 *                                       v3 envelope opens only for the caller
 *                                       that names the same `aad`, so a value
 *                                       copied into another column or row
 *                                       does not decrypt there (audit R-04)
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
 *
 * Backward compatibility: `v1`/`v2` carry no associated data and keep opening
 * when the caller demands none. `encrypt(…, aad)` always writes `v3`;
 * `decrypt(…, aad)` opens `v3` only, and `v3` never opens without its aad.
 * Call sites that must still read rows sealed before they adopted AAD use
 * `decryptBound`, which accepts a legacy envelope unless the deployment
 * sets RENKEI_REQUIRE_AAD=1 (set it once `rewrap --aad` has run).
 */

import {
  createCipheriv,
  createDecipheriv,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import { ok, err } from '@campfhir/safe-functions/helpers';
import type { Result } from '@campfhir/safe-functions/types';

const ALGORITHM = 'aes-256-gcm';
const VERSION_V1 = 'v1';
const VERSION_V2 = 'v2';
const VERSION_V3 = 'v3';
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

/**
 * The key's id as a `v2` envelope names it: 8 hex characters derived from
 * the key with HKDF-SHA256 under a fixed label. A derivation rather than a
 * bare digest, so the id reveals nothing usable about the key and no scanner
 * mistakes it for a password hash.
 */
export function keyId(key: Buffer): string {
  return Buffer.from(
    hkdfSync('sha256', key, Buffer.alloc(0), 'renkei/key-id/v1', KID_HEX_CHARS / 2)
  ).toString('hex');
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

/** Which of the ring's keys sealed a value: a `v2`/`v3` envelope's kid, or null for `v1` (or anything else). */
export function envelopeKeyId(payload: string): string | null {
  const parts = payload.split('.');
  if (parts.length === 5 && (parts[0] === VERSION_V2 || parts[0] === VERSION_V3) && parts[1]) {
    return parts[1];
  }
  return null;
}

/** Whether a secretbox envelope (without any marker before it) is AAD-bound (`v3`). */
export function isBoundEnvelope(payload: string): boolean {
  return payload.startsWith(`${VERSION_V3}.`) && payload.split('.').length === 5;
}

/**
 * The associated data for a purpose, and a row when the seal knows it:
 * `<purpose>` or `<purpose>\0<rowId>`. Purposes are constants at the call
 * sites (`AAD_PURPOSE`); never user input.
 */
export function aadFor(purpose: string, rowId?: string): string {
  return rowId === undefined ? purpose : `${purpose}\0${rowId}`;
}

/** One constant per kind of org-level secret, so one cannot stand in for another. */
export const AAD_PURPOSE = {
  connectorConfig: 'connector-config',
  llmModelKey: 'llm-model-key',
  oidcClientSecret: 'oidc-client-secret',
  knowledgeChunk: 'knowledge-chunk',
} as const;

/**
 * Seals `plaintext`. With `aad` the result is a `v3` envelope that opens only
 * with the same `aad`; without it, `v1` (bare key) or `v2` (keyring) as before.
 */
export function encrypt(plaintext: string, key: Keyring, aad?: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  if (aad !== undefined) cipher.setAAD(Buffer.from(aad, 'utf8'));
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tail = [
    iv.toString('base64'),
    cipher.getAuthTag().toString('base64'),
    ciphertext.toString('base64'),
  ];
  if (aad !== undefined) return [VERSION_V3, keyId(key), ...tail].join('.');
  return isKeyring(key)
    ? [VERSION_V2, keyId(key), ...tail].join('.')
    : [VERSION_V1, ...tail].join('.');
}

function open(
  key: Buffer,
  ivPart: string,
  tagPart: string,
  ciphertextPart: string,
  aad?: string
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
    if (aad !== undefined) decipher.setAAD(Buffer.from(aad, 'utf8'));
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

/**
 * Opens an envelope. `aad` given: only a `v3` sealed with that same `aad`
 * opens (a legacy envelope is refused here; see `decryptBound` for the
 * migration-window reader). `aad` omitted: `v1`/`v2` open as ever, `v3` never.
 */
export function decrypt(
  payload: string,
  key: Keyring,
  aad?: string
): Result<string, 'DECRYPTION_ERROR'> {
  const parts = payload.split('.');
  const version = parts[0];

  if (version === VERSION_V3 && aad === undefined) {
    return err('DECRYPTION_ERROR' as const, {
      message: 'ciphertext is bound to associated data the caller did not name',
    });
  }
  if (version !== VERSION_V3 && aad !== undefined) {
    return err('DECRYPTION_ERROR' as const, {
      message: 'ciphertext carries no associated data but the caller requires it',
    });
  }

  if (version === VERSION_V2 || version === VERSION_V3) {
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
    return open(named, ivPart, tagPart, ciphertextPart, aad);
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

/** True when RENKEI_REQUIRE_AAD is set: legacy (no-AAD) envelopes are then refused by `decryptBound`. */
export function requireBoundEnvelopes(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env.RENKEI_REQUIRE_AAD?.trim().toLowerCase();
  return value === '1' || value === 'true';
}

/**
 * The reader for a purpose that has adopted AAD but may still hold rows
 * sealed before: a `v3` opens under `aad`; a `v1`/`v2` opens as legacy
 * (`legacy: true`, so a caller with a write path can re-seal it) unless the
 * deployment demands bound envelopes. A `v3` for another purpose fails.
 */
export function decryptBound(
  payload: string,
  key: Keyring,
  aad: string,
  env: NodeJS.ProcessEnv = process.env
): Result<{ value: string; legacy: boolean }, 'DECRYPTION_ERROR'> {
  if (isBoundEnvelope(payload)) {
    const opened = decrypt(payload, key, aad);
    return opened.ok ? ok({ value: opened.val, legacy: false }) : opened;
  }
  if (requireBoundEnvelopes(env)) {
    return err('DECRYPTION_ERROR' as const, {
      message: 'legacy ciphertext without associated data refused (RENKEI_REQUIRE_AAD)',
    });
  }
  const opened = decrypt(payload, key);
  return opened.ok ? ok({ value: opened.val, legacy: true }) : opened;
}

/** `decryptBound` for callers that only want the plaintext. */
export function decryptBoundValue(
  payload: string,
  key: Keyring,
  aad: string,
  env: NodeJS.ProcessEnv = process.env
): Result<string, 'DECRYPTION_ERROR'> {
  const opened = decryptBound(payload, key, aad, env);
  return opened.ok ? ok(opened.val.value) : opened;
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
