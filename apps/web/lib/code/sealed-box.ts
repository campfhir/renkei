/**
 * libsodium's sealed box (`crypto_box_seal`), which is how GitHub takes a
 * secret: sealed to the repository's (or environment's) public key, so
 * only GitHub can open it. An ephemeral X25519 key pair is made for each
 * value; the nonce is BLAKE2b-24 of the ephemeral public key and the
 * recipient's; the box is XSalsa20-Poly1305 (tweetnacl's `box`); and what
 * travels is the ephemeral public key followed by the box. The ephemeral
 * secret key is dropped, so not even the sender can open it again.
 *
 * `openSealed` is the other half, for the tests and the browser suite's
 * stand-in for GitHub.
 */

import nacl from 'tweetnacl';
import { blake2b } from '@noble/hashes/blake2b';

const KEY_BYTES = 32;

function nonceFor(ephemeral: Uint8Array, recipient: Uint8Array): Uint8Array {
  const both = new Uint8Array(ephemeral.length + recipient.length);
  both.set(ephemeral, 0);
  both.set(recipient, ephemeral.length);
  return blake2b(both, { dkLen: nacl.box.nonceLength });
}

/** The value sealed to the base64 public key, as base64; null when the key is not one. */
export function sealTo(publicKeyBase64: string, value: string): string | null {
  const recipient = new Uint8Array(Buffer.from(publicKeyBase64, 'base64'));
  if (recipient.length !== KEY_BYTES) return null;
  const ephemeral = nacl.box.keyPair();
  const boxed = nacl.box(
    new Uint8Array(Buffer.from(value, 'utf8')),
    nonceFor(ephemeral.publicKey, recipient),
    recipient,
    ephemeral.secretKey
  );
  return Buffer.concat([ephemeral.publicKey, boxed]).toString('base64');
}

/** What a sealed value holds, for the key pair it was sealed to; null when it does not open. */
export function openSealed(
  sealedBase64: string,
  keys: { publicKey: Uint8Array; secretKey: Uint8Array }
): string | null {
  const sealed = new Uint8Array(Buffer.from(sealedBase64, 'base64'));
  if (sealed.length < KEY_BYTES + nacl.box.overheadLength) return null;
  const ephemeral = sealed.subarray(0, KEY_BYTES);
  const opened = nacl.box.open(
    sealed.subarray(KEY_BYTES),
    nonceFor(ephemeral, keys.publicKey),
    ephemeral,
    keys.secretKey
  );
  return opened ? Buffer.from(opened).toString('utf8') : null;
}
