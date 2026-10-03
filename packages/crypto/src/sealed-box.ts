/**
 * Sealed boxes for key delegation (docs/delegate-key-design.md): bytes
 * sealed to an X25519 public key, which only the matching private key
 * opens. The browser seals a person's user key to each live delegate
 * instance's public key; a delegate instance opens what was sealed to it
 * and nobody else — not the database, not another instance, not the web
 * app in between. The same construction wraps a resource key to a
 * grantee's public key for sharing, and a user key to a new device's
 * ephemeral key during device approval.
 *
 * Wire format, shared with the browser half (`browser/webcrypto.ts`):
 *   sbox1:<ephemeral public key, base64>:<secretbox>
 * where the secretbox (`v1.<iv>.<tag>.<ciphertext>`, AES-256-GCM) holds
 * base64(plaintext) under
 *   HKDF-SHA256(X25519(ephemeral, recipient), salt = ∅,
 *               info = "renkei/sealed-box/v1" ‖ ephemeral ‖ recipient).
 */

import {
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  type KeyObject,
} from 'node:crypto';
import { ok, err } from '@campfhir/safe-functions/helpers';
import type { Result } from '@campfhir/safe-functions/types';
import { encrypt, decrypt } from './secretbox';

export const SEALED_BOX_PREFIX = 'sbox1:';
const INFO = Buffer.from('renkei/sealed-box/v1', 'utf8');
const PUBLIC_KEY_BYTES = 32;

/** DER prefixes node needs around a raw X25519 key. */
const SPKI_PREFIX = Buffer.from('302a300506032b656e032100', 'hex');
const PKCS8_PREFIX = Buffer.from('302e020100300506032b656e04220420', 'hex');

export interface X25519KeyPair {
  /** Raw 32 bytes, as stored in `delegate_instances.public_key` and `user_encryption_keys.public_key`. */
  publicKey: Buffer;
  /** Raw 32 bytes; a delegate instance's lives in memory only. */
  privateKey: Buffer;
}

export function generateX25519KeyPair(): X25519KeyPair {
  const pair = generateKeyPairSync('x25519');
  const spki = pair.publicKey.export({ type: 'spki', format: 'der' });
  const pkcs8 = pair.privateKey.export({ type: 'pkcs8', format: 'der' });
  return {
    publicKey: Buffer.from(spki.subarray(spki.byteLength - 32)),
    privateKey: Buffer.from(pkcs8.subarray(pkcs8.byteLength - 32)),
  };
}

function publicKeyObject(raw: Buffer): KeyObject {
  return createPublicKey({ key: Buffer.concat([SPKI_PREFIX, raw]), format: 'der', type: 'spki' });
}

function privateKeyObject(raw: Buffer): KeyObject {
  return createPrivateKey({
    key: Buffer.concat([PKCS8_PREFIX, raw]),
    format: 'der',
    type: 'pkcs8',
  });
}

/** The public half of a raw private key, for a stored private key whose public half is wanted. */
export function x25519PublicKeyOf(privateKey: Buffer): Buffer {
  const spki = createPublicKey(privateKeyObject(privateKey)).export({
    type: 'spki',
    format: 'der',
  });
  return Buffer.from(spki.subarray(spki.byteLength - 32));
}

function boxKey(shared: Buffer, ephemeralPublic: Buffer, recipientPublic: Buffer): Buffer {
  const info = Buffer.concat([INFO, ephemeralPublic, recipientPublic]);
  return Buffer.from(hkdfSync('sha256', shared, Buffer.alloc(0), info, 32));
}

export function isSealedBox(value: string): boolean {
  return value.startsWith(SEALED_BOX_PREFIX);
}

/** Bytes sealed to a recipient's public key. */
export function sealToPublicKey(recipientPublic: Buffer, plaintext: Buffer): string {
  if (recipientPublic.byteLength !== PUBLIC_KEY_BYTES) {
    throw new Error(`an X25519 public key is ${PUBLIC_KEY_BYTES} bytes`);
  }
  const ephemeral = generateX25519KeyPair();
  const shared = diffieHellman({
    privateKey: privateKeyObject(ephemeral.privateKey),
    publicKey: publicKeyObject(recipientPublic),
  });
  const key = boxKey(shared, ephemeral.publicKey, recipientPublic);
  const box = encrypt(plaintext.toString('base64'), key);
  return `${SEALED_BOX_PREFIX}${ephemeral.publicKey.toString('base64')}:${box}`;
}

/** The inverse, with the recipient's keypair. */
export function openSealedBox(
  recipient: X25519KeyPair,
  sealed: string
): Result<Buffer, 'DECRYPTION_ERROR'> {
  if (!isSealedBox(sealed)) {
    return err('DECRYPTION_ERROR' as const, { message: 'value is not a sealed box' });
  }
  const rest = sealed.slice(SEALED_BOX_PREFIX.length);
  const colon = rest.indexOf(':');
  if (colon <= 0) return err('DECRYPTION_ERROR' as const, { message: 'malformed sealed box' });
  const ephemeralPublic = Buffer.from(rest.slice(0, colon), 'base64');
  if (ephemeralPublic.byteLength !== PUBLIC_KEY_BYTES) {
    return err('DECRYPTION_ERROR' as const, { message: 'malformed ephemeral key' });
  }
  let shared: Buffer;
  try {
    shared = diffieHellman({
      privateKey: privateKeyObject(recipient.privateKey),
      publicKey: publicKeyObject(ephemeralPublic),
    });
  } catch (cause) {
    return err('DECRYPTION_ERROR' as const, { message: 'key agreement failed', cause });
  }
  const key = boxKey(shared, ephemeralPublic, recipient.publicKey);
  const opened = decrypt(rest.slice(colon + 1), key);
  if (!opened.ok) return opened;
  return ok(Buffer.from(opened.val, 'base64'));
}
