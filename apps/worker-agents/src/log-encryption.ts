import { encrypt, decrypt, parseEncryptionKey } from '@renkei/crypto';

/**
 * At-rest encryption for secure()-marked log attributes, worker edition —
 * the same LOG_ENCRYPTION_KEY contract as the web app's lib/log-encryption
 * (the two must agree byte-for-byte, since either side may write rows the
 * web viewer decrypts). Only the direct-Postgres fallback needs this: when
 * shipping over HTTP, secure values travel tagged and the web's ingest sink
 * encrypts them with its own copy of the key.
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
