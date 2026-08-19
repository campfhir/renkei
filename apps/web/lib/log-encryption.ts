import { encrypt, decrypt, parseEncryptionKey } from '@renkei/crypto';

/**
 * At-rest encryption for secure()-marked log attributes (failed-request
 * payloads, response bodies) — the bored-logs PostgresAdapter calls these on
 * write and on query, so the viewer shows plaintext while the table holds
 * ciphertext.
 *
 * Keyed by LOG_ENCRYPTION_KEY (32 bytes, base64 — `openssl rand -base64 32`),
 * deliberately NOT TOKEN_ENCRYPTION_KEY: leaking a log-reading key must not
 * also unseal every provider token.
 *
 * Wire shape: the adapter stores `encrypt(...).toString('base64url')` and
 * hands that same string back to decrypt — so decrypt un-base64urls before
 * opening the secretbox payload.
 *
 * Caveat the operator accepts by setting the key: encrypted attribute values
 * cannot be substring-searched in the log viewer. Filter by the plain
 * attributes (tenant, subject, status, url); the bodies decrypt in the
 * detail view.
 */
export type LogCipher = {
  encrypt: (plaintext: string) => Buffer;
  decrypt: (ciphertext: string) => string;
};

export type LogCipherResult =
  { state: 'off' } | { state: 'invalid'; error: string } | { state: 'on'; cipher: LogCipher };

export function resolveLogCipher(
  env: string | undefined = process.env.LOG_ENCRYPTION_KEY
): LogCipherResult {
  if (!env) return { state: 'off' };
  const keyResult = parseEncryptionKey(env);
  if (!keyResult.ok) {
    return {
      state: 'invalid',
      error: 'LOG_ENCRYPTION_KEY must be 32 bytes base64 (openssl rand -base64 32)',
    };
  }
  const key = keyResult.val;
  return {
    state: 'on',
    cipher: {
      encrypt: (plaintext) => Buffer.from(encrypt(plaintext, key), 'utf8'),
      decrypt: (stored) => {
        const payload = Buffer.from(stored, 'base64url').toString('utf8');
        const opened = decrypt(payload, key);
        if (!opened.ok) {
          throw new Error('log attribute decryption failed — wrong or rotated LOG_ENCRYPTION_KEY?');
        }
        return opened.val;
      },
    },
  };
}

/**
 * Boot-time guard for the paths that write secure()-marked attributes to the
 * logs table. At-rest encryption is REQUIRED there: a missing or malformed
 * LOG_ENCRYPTION_KEY is a fatal misconfiguration, never a silent downgrade to
 * plaintext. Returns the cipher, or throws — the boot call sites let the throw
 * crash the process (fail closed) rather than persisting sensitive bodies in
 * the clear.
 */
export function requireLogCipher(
  env: string | undefined = process.env.LOG_ENCRYPTION_KEY
): LogCipher {
  const resolved = resolveLogCipher(env);
  if (resolved.state === 'on') return resolved.cipher;
  const detail =
    resolved.state === 'invalid'
      ? resolved.error
      : 'LOG_ENCRYPTION_KEY is not set (needs 32 bytes base64 — openssl rand -base64 32)';
  throw new Error(
    `log encryption is required but unavailable: ${detail}. Refusing to store secure log attributes unencrypted.`
  );
}
