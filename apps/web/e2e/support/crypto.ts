/**
 * The browser's key crypto, in node:crypto, for specs that act as a
 * person's browser (e2e/support/keys.ts): `@renkei/crypto`'s secretbox,
 * sealed box, user-key format and device code, reproduced byte for byte
 * so Playwright's own transpilation never resolves a workspace package.
 * Ported unchanged from e2e/keys.ts, which phase 2 retires.
 */

import {
  createCipheriv,
  createDecipheriv,
  createHash,
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

/** The inverse of `secretbox`, for reading a wrapping this helper wrote earlier. */
export function openSecretbox(payload: string, key: Buffer): string {
  const [, iv, tag, ciphertext] = payload.split('.');
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv!, 'base64'));
  decipher.setAuthTag(Buffer.from(tag!, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertext!, 'base64')),
    decipher.final(),
  ]).toString('utf8');
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

const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let i = 0; i < 8; i += 1) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** `@renkei/crypto`'s written-down form of a user key: 14 groups of 4 base32 characters, the last 4 a CRC checksum. */
export function formatUserKey(bytes: Buffer): string {
  let raw = '';
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      raw += BASE32[(buffer >> bits) & 31];
    }
  }
  if (bits > 0) raw += BASE32[(buffer << (5 - bits)) & 31];
  const top = crc32(bytes) >>> 12;
  raw +=
    BASE32[(top >> 15) & 31] +
    BASE32[(top >> 10) & 31] +
    BASE32[(top >> 5) & 31] +
    BASE32[top & 31];
  const groups: string[] = [];
  for (let i = 0; i < raw.length; i += 4) groups.push(raw.slice(i, i + 4));
  return groups.join('-');
}

/** `@renkei/crypto`'s device code and instance fingerprint: ten base32 characters of SHA-256, grouped in fives. */
export function deviceCodeOf(publicKey: Buffer): string {
  const digest = createHash('sha256').update(publicKey).digest();
  let raw = '';
  let buffer = 0;
  let bits = 0;
  for (const byte of digest) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      raw += BASE32[(buffer >> bits) & 31];
    }
  }
  const chars = raw.slice(0, 10).toUpperCase();
  return `${chars.slice(0, 5)}-${chars.slice(5)}`;
}
