/**
 * Per-user keys and the envelopes built on them — the pure half of
 * `@renkei/user-keys` (which owns the rows). Three layers, each a plain
 * function over bytes so every process derives the same keys:
 *
 *  1. The MASTER is a deployment secret: USER_KEY_ENCRYPTION_KEY, set on the
 *     delegate alone (docs/delegate-key-design.md) — no fallback to the
 *     other keys any more, so no other process can derive a key by accident (the
 *     same chain the content envelope resolves, so nothing new has to be
 *     deployed to turn this on; set the dedicated variable to rotate it
 *     independently).
 *
 *  2. A person's KEY-ENCRYPTION KEY (KEK) is never stored. It is derived
 *     with HKDF-SHA256 from the master, a random per-person salt kept in
 *     `user_encryption_keys`, and the person's identity (tenant, OIDC
 *     subject) as the HKDF info. Two people under one master therefore
 *     hold unrelated keys; a new salt is a new KEK (rotation), and a
 *     deleted salt row leaves every wrapping made for that person
 *     unopenable (crypto-shredding).
 *
 *  3. A RESOURCE DATA KEY (DEK) is 32 random bytes per chat. It exists at
 *     rest only `wrapKey`ed under the KEK of each person allowed to open
 *     the chat — one `resource_key_grants` row each. Sharing a chat is
 *     `unwrapKey` under the owner's KEK and `wrapKey` under the grantee's.
 *     Content is sealed under the DEK in the `renc2:<keyId>:<secretbox>`
 *     envelope, the key id riding along so a reader knows which key the
 *     row wants before it tries.
 *
 * `uenc1:` is the KEK used directly, for a value that belongs to exactly
 * one person and is never shared (a connector credential): no DEK, no key
 * id — the owner is the row's subject.
 *
 * What this is and is not: every process holding the master can derive
 * any KEK, so this is key SEPARATION — per-person keys, per-chat keys,
 * a sharing model and a shred — not end-to-end encryption. A sweep or a
 * worker can still read a chat on its owner's behalf, which is what lets
 * turns resume and notes land while the person is away.
 */

import { createHash, hkdfSync, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { ok, err } from '@campfhir/safe-functions/helpers';
import type { Result } from '@campfhir/safe-functions/types';
import { encrypt, decrypt, parseEncryptionKey } from './secretbox';

export const DATA_KEY_BYTES = 32;
export const USER_KEY_SALT_BYTES = 32;

/** The HKDF info domain; a new version is a new key space. */
const KEK_INFO_VERSION = 'renkei/user-kek/v1';

export const RESOURCE_ENVELOPE_PREFIX = 'renc2:';
export const USER_ENVELOPE_PREFIX = 'uenc1:';

/** The master every KEK derives from; see the module comment for the chain. */
export function userKeyMaster(): Result<
  Buffer,
  'MISSING_USER_KEY_MASTER' | 'INVALID_ENCRYPTION_KEY'
> {
  const encoded = process.env.USER_KEY_ENCRYPTION_KEY || '';
  if (!encoded) {
    return err('MISSING_USER_KEY_MASTER' as const, {
      message: 'USER_KEY_ENCRYPTION_KEY is not set — ' + 'per-user keys cannot be derived.',
    });
  }
  return parseEncryptionKey(encoded);
}

export function generateDataKey(): Buffer {
  return randomBytes(DATA_KEY_BYTES);
}

export function generateUserKeySalt(): Buffer {
  return randomBytes(USER_KEY_SALT_BYTES);
}

/**
 * A person's KEK: HKDF-SHA256(master, salt, info = version ‖ tenant ‖ subject).
 * Deterministic for one (master, salt, tenant, subject); the salt is what
 * makes it rotatable without touching anyone else's keys.
 */
export function deriveUserKek(
  master: Buffer,
  salt: Buffer,
  subject: string
): Buffer {
  const info = Buffer.from(`${KEK_INFO_VERSION}\0${tenantId}\0${subject}`, 'utf8');
  return Buffer.from(hkdfSync('sha256', master, salt, info, DATA_KEY_BYTES));
}

/** A data key sealed under a KEK, as the key-grant row stores it. */
export function wrapKey(key: Buffer, kek: Buffer): string {
  return encrypt(key.toString('base64'), kek);
}

export function unwrapKey(wrapped: string, kek: Buffer): Result<Buffer, 'DECRYPTION_ERROR'> {
  const opened = decrypt(wrapped, kek);
  if (!opened.ok) return opened;
  const key = Buffer.from(opened.val, 'base64');
  if (key.byteLength !== DATA_KEY_BYTES) {
    return err('DECRYPTION_ERROR' as const, {
      message: `unwrapped key is ${key.byteLength} bytes, expected ${DATA_KEY_BYTES}`,
    });
  }
  return ok(key);
}

/** Content sealed under a resource's data key: `renc2:<keyId>:<secretbox>`. */
export function encryptWithResourceKey(plaintext: string, keyId: string, key: Buffer): string {
  return `${RESOURCE_ENVELOPE_PREFIX}${keyId}:${encrypt(plaintext, key)}`;
}

export function isResourceEncrypted(value: string): boolean {
  return value.startsWith(RESOURCE_ENVELOPE_PREFIX);
}

/** The key id a `renc2` envelope names, and the secretbox payload after it. */
export function parseResourceEnvelope(value: string): { keyId: string; payload: string } | null {
  if (!isResourceEncrypted(value)) return null;
  const rest = value.slice(RESOURCE_ENVELOPE_PREFIX.length);
  const colon = rest.indexOf(':');
  if (colon <= 0) return null;
  const keyId = rest.slice(0, colon);
  const payload = rest.slice(colon + 1);
  return payload ? { keyId, payload } : null;
}

/**
 * Open a `renc2` envelope with the key it names. The id check is what
 * turns "wrong key" from an opaque auth failure into a message that says
 * which key the row wants.
 */
export function decryptWithResourceKey(
  value: string,
  keyId: string,
  key: Buffer
): Result<string, 'DECRYPTION_ERROR' | 'WRONG_KEY'> {
  const parsed = parseResourceEnvelope(value);
  if (!parsed) {
    return err('DECRYPTION_ERROR' as const, { message: 'value is not a renc2 envelope' });
  }
  if (parsed.keyId !== keyId) {
    return err('WRONG_KEY' as const, {
      message: `envelope is sealed under key ${parsed.keyId}, not ${keyId}`,
    });
  }
  return decrypt(parsed.payload, key);
}

/** A person's own value sealed directly under their KEK: `uenc1:<secretbox>`. */
export function sealForUser(plaintext: string, kek: Buffer): string {
  return USER_ENVELOPE_PREFIX + encrypt(plaintext, kek);
}

export function isUserSealed(value: string): boolean {
  return value.startsWith(USER_ENVELOPE_PREFIX);
}

export function openForUser(value: string, kek: Buffer): Result<string, 'DECRYPTION_ERROR'> {
  if (!isUserSealed(value)) {
    return err('DECRYPTION_ERROR' as const, { message: 'value is not a uenc1 envelope' });
  }
  return decrypt(value.slice(USER_ENVELOPE_PREFIX.length), kek);
}

/**
 * Bring-your-own-key. A person who opts out of the managed KEK holds one
 * derived from a PASSPHRASE instead: scrypt over the passphrase and their
 * salt, then HKDF into a key space of its own, so the deployment master
 * plays no part and nothing Renkei stores can produce it. scrypt's cost
 * (32MB, ~50–100ms) is paid once per unlock, never per row.
 */
const OWN_KEK_INFO_VERSION = 'renkei/user-kek-own/v1';
const UNLOCK_KEY_INFO_VERSION = 'renkei/user-kek-unlock/v1';
const VERIFIER_INFO = 'renkei/user-kek-verifier/v1';
const SCRYPT = { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

export const OWN_KEY_PASSPHRASE_MIN_CHARS = 12;
export const OWN_KEY_PASSPHRASE_MAX_CHARS = 256;

export function deriveOwnKek(
  passphrase: string,
  salt: Buffer,
  subject: string
): Buffer {
  const ikm = scryptSync(
    Buffer.from(passphrase.normalize('NFKC'), 'utf8'),
    salt,
    DATA_KEY_BYTES,
    SCRYPT
  );
  const info = Buffer.from(`${OWN_KEK_INFO_VERSION}\0${tenantId}\0${subject}`, 'utf8');
  return Buffer.from(hkdfSync('sha256', ikm, salt, info, DATA_KEY_BYTES));
}

/**
 * While a person's own key is UNLOCKED it is kept sealed under this key —
 * derived from the master like a managed KEK, in a key space of its own —
 * so every process can use it for the window and none can once the row
 * is cleared.
 */
export function deriveUnlockKey(
  master: Buffer,
  salt: Buffer,
  subject: string
): Buffer {
  const info = Buffer.from(`${UNLOCK_KEY_INFO_VERSION}\0${tenantId}\0${subject}`, 'utf8');
  return Buffer.from(hkdfSync('sha256', master, salt, info, DATA_KEY_BYTES));
}

/** A tag that proves a KEK without revealing it — what a stored passphrase check compares against. */
export function kekVerifier(kek: Buffer): string {
  return createHash('sha256')
    .update(
      Buffer.from(
        hkdfSync('sha256', kek, Buffer.alloc(0), Buffer.from(VERIFIER_INFO), DATA_KEY_BYTES)
      )
    )
    .digest('hex');
}

export function verifierMatches(kek: Buffer, verifier: string): boolean {
  const left = Buffer.from(kekVerifier(kek), 'hex');
  const right = Buffer.from(verifier, 'hex');
  return left.byteLength === right.byteLength && timingSafeEqual(left, right);
}
