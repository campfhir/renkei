/**
 * Ed25519 for the delegate's signed instance list (docs/delegate-key-design.md,
 * "Which delegate am I sealing to?"): a per-deployment keypair whose public
 * half a browser learns once and whose signature over the live-instance
 * list lets that browser accept a new instance's key without asking. Raw
 * 32-byte keys and 64-byte signatures, node's own primitives; the browser
 * half (`browser/webcrypto.ts`, `verifyEd25519`) checks what this signs,
 * which the tests prove.
 */

import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
  verify,
  type KeyObject,
} from 'node:crypto';

const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
const KEY_BYTES = 32;
const SIGNATURE_BYTES = 64;

export interface Ed25519KeyPair {
  publicKey: Buffer;
  privateKey: Buffer;
}

export function generateEd25519KeyPair(): Ed25519KeyPair {
  const pair = generateKeyPairSync('ed25519');
  const spki = pair.publicKey.export({ type: 'spki', format: 'der' });
  const pkcs8 = pair.privateKey.export({ type: 'pkcs8', format: 'der' });
  return {
    publicKey: Buffer.from(spki.subarray(spki.byteLength - KEY_BYTES)),
    privateKey: Buffer.from(pkcs8.subarray(pkcs8.byteLength - KEY_BYTES)),
  };
}

function privateKeyObject(raw: Buffer): KeyObject {
  return createPrivateKey({
    key: Buffer.concat([PKCS8_PREFIX, raw]),
    format: 'der',
    type: 'pkcs8',
  });
}

function publicKeyObject(raw: Buffer): KeyObject {
  return createPublicKey({ key: Buffer.concat([SPKI_PREFIX, raw]), format: 'der', type: 'spki' });
}

/** The public half of a raw private key. */
export function ed25519PublicKeyOf(privateKey: Buffer): Buffer {
  const spki = createPublicKey(privateKeyObject(privateKey)).export({
    type: 'spki',
    format: 'der',
  });
  return Buffer.from(spki.subarray(spki.byteLength - KEY_BYTES));
}

export function signEd25519(privateKey: Buffer, message: Buffer): Buffer {
  if (privateKey.byteLength !== KEY_BYTES) throw new Error('an Ed25519 private key is 32 bytes');
  return sign(null, message, privateKeyObject(privateKey));
}

export function verifyEd25519(publicKey: Buffer, message: Buffer, signature: Buffer): boolean {
  if (publicKey.byteLength !== KEY_BYTES || signature.byteLength !== SIGNATURE_BYTES) return false;
  try {
    return verify(null, message, publicKeyObject(publicKey), signature);
  } catch {
    return false;
  }
}
