/**
 * Content-at-rest encryption for the knowledge layer: knowledge_chunks
 * bodies and the content-bearing fields of embedding_jobs payloads.
 *
 * The envelope is secretbox's (`v1.<iv>.<tag>.<ct>`) behind a distinct
 * `renc1:` marker. The invariant is STRICT: every stored value is an
 * envelope, and a value without the marker is treated as an error, never
 * passed through — plaintext at rest is exactly the condition this module
 * exists to make impossible, so readers fail visibly instead of quietly
 * accepting it. (`pnpm encrypt-at-rest` in packages/knowledge converted
 * the pre-rollout rows; it must have run — and the job queue drained —
 * before this strict reader ships.)
 *
 * The key is CONTENT_ENCRYPTION_KEY, falling back to TOKEN_ENCRYPTION_KEY
 * (already present on every service) so no new deployment config is
 * required. Set the dedicated variable to rotate content independently of
 * credentials; either rotates as a keyring (CONTENT_ENCRYPTION_KEYS /
 * TOKEN_ENCRYPTION_KEYS, secretbox.ts), so rows under the previous key
 * stay readable until `pnpm --filter @renkei/user-keys rewrap` has moved them.
 *
 * Trade acknowledged at the call sites: SQL string matching against
 * encrypted content is impossible — lookups go by ref_id/metadata/vector,
 * all of which stay plaintext.
 */

import { err } from '@campfhir/safe-functions/helpers';
import type { Result } from '@campfhir/safe-functions/types';
import { encrypt, decrypt, loadKeyring, type Keyring } from './secretbox';

/** Exported for the backfill sweep's SQL predicate; never build envelopes by hand. */
export const CONTENT_ENVELOPE_PREFIX = 'renc1:';
const CONTENT_PREFIX = CONTENT_ENVELOPE_PREFIX;

export function contentEncryptionKey(
  env: NodeJS.ProcessEnv = process.env
): Result<Keyring, 'MISSING_CONTENT_KEY' | 'INVALID_ENCRYPTION_KEY'> {
  // Each is a keyring: CONTENT_ENCRYPTION_KEYS (current first, previous
  // behind it) or CONTENT_ENCRYPTION_KEY; else the TOKEN pair the same way.
  const name =
    env.CONTENT_ENCRYPTION_KEYS || env.CONTENT_ENCRYPTION_KEY
      ? 'CONTENT_ENCRYPTION_KEY'
      : env.TOKEN_ENCRYPTION_KEYS || env.TOKEN_ENCRYPTION_KEY
        ? 'TOKEN_ENCRYPTION_KEY'
        : null;
  if (!name) {
    return err('MISSING_CONTENT_KEY' as const, {
      message:
        'Neither CONTENT_ENCRYPTION_KEY nor TOKEN_ENCRYPTION_KEY is set — ' +
        'content cannot be encrypted at rest.',
    });
  }
  return loadKeyring(name, env);
}

export function encryptContent(plaintext: string, key: Buffer): string {
  return CONTENT_PREFIX + encrypt(plaintext, key);
}

export function isEncryptedContent(value: string): boolean {
  return value.startsWith(CONTENT_PREFIX);
}

/** Envelope → plaintext. A value without the envelope marker is an error. */
export function decryptContent(value: string, key: Buffer): Result<string, 'DECRYPTION_ERROR'> {
  if (!isEncryptedContent(value)) {
    return err('DECRYPTION_ERROR' as const, {
      message: 'value is not an encrypted envelope — plaintext at rest is not accepted',
    });
  }
  return decrypt(value.slice(CONTENT_PREFIX.length), key);
}

/**
 * Read-side convenience for surfaces that must render SOMETHING per row:
 * an envelope decrypts; every failure mode (unencrypted value, no key,
 * bad key) comes back as a visible marker instead of the stored bytes or
 * a thrown 500 — one broken row must not take down a whole search result
 * page, and an unencrypted row must be seen, not silently served.
 */
export function revealContent(value: string, key: Buffer | null): string {
  if (!isEncryptedContent(value)) {
    return '[content unavailable: stored unencrypted — run the encrypt-at-rest sweep]';
  }
  if (!key) return '[content unavailable: encryption key not configured]';
  const opened = decryptContent(value, key);
  return opened.ok ? opened.val : '[content unavailable: decryption failed]';
}
