/**
 * Content-at-rest encryption for the knowledge layer: knowledge_chunks
 * bodies and the content-bearing fields of embedding_jobs payloads.
 *
 * The envelope is secretbox's (`v1.<iv>.<tag>.<ct>`) behind a distinct
 * `renc1:` marker, so a reader can tell an encrypted value from a legacy
 * plaintext row unambiguously and pass the latter through — that dual-read
 * is what makes the rollout migration-free: new writes are encrypted, old
 * rows keep working, and a batched sweep converts them at leisure.
 *
 * The key is CONTENT_ENCRYPTION_KEY, falling back to TOKEN_ENCRYPTION_KEY
 * (already present on every service) so turning this on requires no new
 * deployment config. Set the dedicated variable to rotate content
 * independently of credentials.
 *
 * Trade acknowledged at the call sites: SQL string matching against
 * encrypted content is impossible — lookups go by ref_id/metadata/vector,
 * all of which stay plaintext.
 */

import { ok, err } from '@campfhir/safe-functions/helpers';
import type { Result } from '@campfhir/safe-functions/types';
import { encrypt, decrypt, parseEncryptionKey } from './secretbox';

/** Exported for the backfill sweep's SQL predicate; never build envelopes by hand. */
export const CONTENT_ENVELOPE_PREFIX = 'renc1:';
const CONTENT_PREFIX = CONTENT_ENVELOPE_PREFIX;

export function contentEncryptionKey(): Result<
  Buffer,
  'MISSING_CONTENT_KEY' | 'INVALID_ENCRYPTION_KEY'
> {
  const encoded = process.env.CONTENT_ENCRYPTION_KEY || process.env.TOKEN_ENCRYPTION_KEY || '';
  if (!encoded) {
    return err('MISSING_CONTENT_KEY' as const, {
      message:
        'Neither CONTENT_ENCRYPTION_KEY nor TOKEN_ENCRYPTION_KEY is set — ' +
        'content cannot be encrypted at rest.',
    });
  }
  return parseEncryptionKey(encoded);
}

export function encryptContent(plaintext: string, key: Buffer): string {
  return CONTENT_PREFIX + encrypt(plaintext, key);
}

export function isEncryptedContent(value: string): boolean {
  return value.startsWith(CONTENT_PREFIX);
}

/** Envelope → plaintext; a legacy plaintext value passes through untouched. */
export function decryptContent(value: string, key: Buffer): Result<string, 'DECRYPTION_ERROR'> {
  if (!isEncryptedContent(value)) return ok(value);
  return decrypt(value.slice(CONTENT_PREFIX.length), key);
}

/**
 * Read-side convenience for surfaces that must render SOMETHING per row: a
 * legacy value passes through, an envelope decrypts, and the two failure
 * modes (no key, bad key) come back as a visible marker instead of
 * ciphertext soup or a thrown 500 — one broken row must not take down a
 * whole search result page.
 */
export function revealContent(value: string, key: Buffer | null): string {
  if (!isEncryptedContent(value)) return value;
  if (!key) return '[content unavailable: encryption key not configured]';
  const opened = decryptContent(value, key);
  return opened.ok ? opened.val : '[content unavailable: decryption failed]';
}
