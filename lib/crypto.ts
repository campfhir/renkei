import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';
import { getConfig } from './env';

const ALGORITHM = 'aes-256-gcm';
const NONCE_LENGTH = 12; // 12 bytes for GCM
const TAG_LENGTH = 16; // 16 bytes for GCM

/**
 * Decrypt data encrypted with AES-256-GCM.
 * Data format: base64(nonce || ciphertext || tag)
 */
export function decrypt(encryptedData: string, keyBuffer?: Buffer): string {
  // @ts-ignore - Buffer type conflict between crypto and global Buffer
  const key = keyBuffer || Buffer.from(getConfig().TOKEN_ENCRYPTION_KEY, 'base64');

  try {
    const buffer = Buffer.from(encryptedData, 'base64');

    const nonce = buffer.slice(0, NONCE_LENGTH);
    const tag = buffer.slice(buffer.length - TAG_LENGTH);
    const ciphertext = buffer.slice(NONCE_LENGTH, buffer.length - TAG_LENGTH);

    const decipher = createDecipheriv(ALGORITHM, key, nonce);
    decipher.setAuthTag(tag);

    const decrypted = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]);

    return decrypted.toString('utf-8');
  } catch (err) {
    throw new Error(`Decryption failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export function encrypt(plaintext: string, keyBuffer?: Buffer): string {
  // @ts-ignore - Buffer type conflict between crypto and global Buffer
  const key = keyBuffer || Buffer.from(getConfig().TOKEN_ENCRYPTION_KEY, 'base64');
  const nonce = randomBytes(NONCE_LENGTH);

  const cipher = createCipheriv(ALGORITHM, key, nonce);
  const encrypted = Buffer.concat([
    cipher.update(plaintext, 'utf-8'),
    cipher.final(),
  ]);

  const tag = cipher.getAuthTag();
  const combined = Buffer.concat([nonce, encrypted, tag]);

  return combined.toString('base64');
}
