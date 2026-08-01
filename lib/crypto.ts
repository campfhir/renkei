import { getConfig } from './env';

/**
 * Decrypt data encrypted with AES-256-GCM.
 * Data format: base64(nonce || ciphertext || tag)
 */
export function decrypt(encryptedData: string): string {
  const config = getConfig();
  // TODO: Implement AES-256-GCM decryption
  // Uses config.TOKEN_ENCRYPTION_KEY (32-byte key)
  // Parses base64 input to extract nonce, ciphertext, tag
  // Returns decrypted plaintext as string
  throw new Error('decrypt not yet implemented');
}

export function encrypt(plaintext: string): string {
  const config = getConfig();
  // TODO: Implement AES-256-GCM encryption
  // Generates random 12-byte nonce
  // Encrypts plaintext with config.TOKEN_ENCRYPTION_KEY
  // Returns base64(nonce || ciphertext || tag)
  throw new Error('encrypt not yet implemented');
}
