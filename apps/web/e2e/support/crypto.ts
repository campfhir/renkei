/**
 * The browser's enrollment crypto, in node:crypto, for the sign-in helper
 * that enrolls a person as their browser would (./person.ts):
 * `@renkei/crypto`'s secretbox and sealed box, reproduced byte for byte so
 * Playwright's own transpilation never resolves a workspace package.
 */

import {
  createCipheriv,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
} from 'node:crypto';

/** `@renkei/crypto`'s secretbox: `v1.<iv>.<tag>.<ciphertext>` (aes-256-gcm). */
export function secretbox(plaintext: string, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return [
    'v1',
    iv.toString('base64'),
    cipher.getAuthTag().toString('base64'),
    ciphertext.toString('base64'),
  ].join('.');
}

const SPKI_PREFIX = Buffer.from('302a300506032b656e032100', 'hex');
const PKCS8_PREFIX = Buffer.from('302e020100300506032b656e04220420', 'hex');

export function x25519Pair(privateKey?: Buffer): { publicKey: Buffer; privateKey: Buffer } {
  if (privateKey) {
    const spki = createPublicKey(
      createPrivateKey({
        key: Buffer.concat([PKCS8_PREFIX, privateKey]),
        format: 'der',
        type: 'pkcs8',
      })
    ).export({ type: 'spki', format: 'der' });
    return { publicKey: Buffer.from(spki.subarray(spki.byteLength - 32)), privateKey };
  }
  const pair = generateKeyPairSync('x25519');
  const spki = pair.publicKey.export({ type: 'spki', format: 'der' });
  const pkcs8 = pair.privateKey.export({ type: 'pkcs8', format: 'der' });
  return {
    publicKey: Buffer.from(spki.subarray(spki.byteLength - 32)),
    privateKey: Buffer.from(pkcs8.subarray(pkcs8.byteLength - 32)),
  };
}

/** `@renkei/crypto`'s sealed box: `sbox1:<ephemeral public>:<secretbox over base64(plaintext)>`. */
export function sealToPublicKey(recipientPublic: Buffer, plaintext: Buffer): string {
  const ephemeral = x25519Pair();
  const shared = diffieHellman({
    privateKey: createPrivateKey({
      key: Buffer.concat([PKCS8_PREFIX, ephemeral.privateKey]),
      format: 'der',
      type: 'pkcs8',
    }),
    publicKey: createPublicKey({
      key: Buffer.concat([SPKI_PREFIX, recipientPublic]),
      format: 'der',
      type: 'spki',
    }),
  });
  const info = Buffer.concat([
    Buffer.from('renkei/sealed-box/v1', 'utf8'),
    ephemeral.publicKey,
    recipientPublic,
  ]);
  const key = Buffer.from(hkdfSync('sha256', shared, Buffer.alloc(0), info, 32));
  return `sbox1:${ephemeral.publicKey.toString('base64')}:${secretbox(plaintext.toString('base64'), key)}`;
}
