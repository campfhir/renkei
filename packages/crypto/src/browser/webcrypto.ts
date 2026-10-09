/**
 * The browser's half of the key hierarchy (docs/delegate-key-design.md),
 * over WebCrypto alone: the user key is generated here, the person's
 * X25519 keypair and automation key are generated and wrapped here, and
 * the user key is sealed to a delegate instance's public key here. Byte
 * for byte compatible with the node side (`../secretbox.ts`,
 * `../sealed-box.ts`), which the tests prove by opening in one what the
 * other sealed.
 *
 * Wire formats:
 *   secretbox   `v1.<iv>.<tag>.<ciphertext>`      AES-256-GCM, base64 parts
 *   wrapped key  secretbox over base64(key bytes)
 *   sealed box  `sbox1:<ephemeral public>:<secretbox>`
 *               key = HKDF-SHA256(X25519(ephemeral, recipient), salt = ∅,
 *                     info = "renkei/sealed-box/v1" ‖ ephemeral ‖ recipient)
 *
 * Runs wherever `globalThis.crypto.subtle` is: a page, a worker, node 20+.
 */

import {
  base64ToBytes,
  bytesToBase64,
  bytesToUtf8,
  concatBytes,
  toBytes,
  utf8ToBytes,
  type Bytes,
} from './encoding';

/**
 * WebCrypto's types, read off the global so this module needs neither the
 * DOM lib nor node's: the same shapes exist in both.
 */
type Subtle = typeof globalThis.crypto.subtle;
type WebCryptoKey = Awaited<ReturnType<Subtle['importKey']>>;
type WebKeyUsage = Parameters<Subtle['importKey']>[4] extends Iterable<infer U> ? U : never;
interface WebKeyPair {
  publicKey: WebCryptoKey;
  privateKey: WebCryptoKey;
}

function isWebKey(value: unknown): value is WebCryptoKey {
  return typeof value === 'object' && value !== null && 'type' in value && 'algorithm' in value;
}

/** A fresh X25519 keypair as WebCrypto keys; `generateKey`'s union return narrowed honestly. */
async function x25519Pair(): Promise<WebKeyPair> {
  const generated: unknown = await subtle().generateKey({ name: 'X25519' }, true, ['deriveBits']);
  if (
    typeof generated === 'object' &&
    generated !== null &&
    'publicKey' in generated &&
    'privateKey' in generated &&
    isWebKey(generated.publicKey) &&
    isWebKey(generated.privateKey)
  ) {
    return { publicKey: generated.publicKey, privateKey: generated.privateKey };
  }
  throw new Error('X25519 did not yield a keypair');
}

const IV_BYTES = 12;
const TAG_BYTES = 16;
export const SEALED_BOX_PREFIX = 'sbox1:';
const SEALED_BOX_INFO = 'renkei/sealed-box/v1';

/** PKCS#8 for a raw X25519 private key, as WebCrypto and node both import it. */
const X25519_PKCS8_PREFIX = Uint8Array.from([
  0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x6e, 0x04, 0x22, 0x04, 0x20,
]);

function subtle(): Subtle {
  const api = globalThis.crypto;
  if (!api || !api.subtle) throw new Error('WebCrypto is not available here');
  return api.subtle;
}

export function randomBytes(length: number): Bytes {
  const out = new Uint8Array(length);
  globalThis.crypto.getRandomValues(out);
  return out;
}

async function aesKey(raw: Uint8Array, usage: WebKeyUsage[]): Promise<WebCryptoKey> {
  if (raw.length !== 32) throw new Error('an AES-256 key is 32 bytes');
  return subtle().importKey('raw', toBytes(raw), { name: 'AES-GCM' }, false, usage);
}

/** `@renkei/crypto`'s secretbox over a utf-8 string, under a raw 32-byte key. */
export async function secretboxSeal(plaintext: string, key: Uint8Array): Promise<string> {
  const iv = randomBytes(IV_BYTES);
  const sealed = new Uint8Array(
    await subtle().encrypt(
      { name: 'AES-GCM', iv },
      await aesKey(key, ['encrypt']),
      utf8ToBytes(plaintext)
    )
  );
  const ciphertext = sealed.slice(0, sealed.length - TAG_BYTES);
  const tag = sealed.slice(sealed.length - TAG_BYTES);
  return ['v1', bytesToBase64(iv), bytesToBase64(tag), bytesToBase64(ciphertext)].join('.');
}

export async function secretboxOpen(payload: string, key: Uint8Array): Promise<string | null> {
  const parts = payload.split('.');
  if (parts.length !== 4 || parts[0] !== 'v1') return null;
  const iv = base64ToBytes(parts[1]);
  const tag = base64ToBytes(parts[2]);
  const ciphertext = base64ToBytes(parts[3]);
  if (!iv || !tag || !ciphertext || iv.length !== IV_BYTES || tag.length !== TAG_BYTES) return null;
  try {
    const opened = await subtle().decrypt(
      { name: 'AES-GCM', iv },
      await aesKey(key, ['decrypt']),
      concatBytes(ciphertext, tag)
    );
    return bytesToUtf8(new Uint8Array(opened));
  } catch {
    return null;
  }
}

/** A key wrapped under another, as `resource_key_grants.wrapped_key` and the user row store it. */
export async function wrapBytes(bytes: Uint8Array, key: Uint8Array): Promise<string> {
  return secretboxSeal(bytesToBase64(bytes), key);
}

export async function unwrapBytes(wrapped: string, key: Uint8Array): Promise<Bytes | null> {
  const opened = await secretboxOpen(wrapped, key);
  return opened === null ? null : base64ToBytes(opened);
}

export interface RawKeyPair {
  publicKey: Bytes;
  privateKey: Bytes;
}

/** An X25519 keypair as raw 32-byte halves. */
export async function generateKeyPair(): Promise<RawKeyPair> {
  const pair = await x25519Pair();
  const publicKey = new Uint8Array(await subtle().exportKey('raw', pair.publicKey));
  const pkcs8 = new Uint8Array(await subtle().exportKey('pkcs8', pair.privateKey));
  return { publicKey, privateKey: pkcs8.slice(pkcs8.length - 32) };
}

async function importPublic(raw: Uint8Array): Promise<WebCryptoKey> {
  return subtle().importKey('raw', toBytes(raw), { name: 'X25519' }, true, []);
}

async function importPrivate(raw: Uint8Array): Promise<WebCryptoKey> {
  return subtle().importKey(
    'pkcs8',
    concatBytes(X25519_PKCS8_PREFIX, raw),
    { name: 'X25519' },
    false,
    ['deriveBits']
  );
}

async function boxKey(
  shared: Bytes,
  ephemeralPublic: Uint8Array,
  recipientPublic: Uint8Array
): Promise<Bytes> {
  const ikm = await subtle().importKey('raw', shared, 'HKDF', false, ['deriveBits']);
  const info = concatBytes(utf8ToBytes(SEALED_BOX_INFO), ephemeralPublic, recipientPublic);
  const bits = await subtle().deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info },
    ikm,
    256
  );
  return new Uint8Array(bits);
}

/** Bytes sealed to a recipient's X25519 public key; only its private key opens them. */
export async function sealToPublicKey(
  recipientPublic: Uint8Array,
  plaintext: Uint8Array
): Promise<string> {
  const ephemeral = await x25519Pair();
  const ephemeralPublic = new Uint8Array(await subtle().exportKey('raw', ephemeral.publicKey));
  const shared = new Uint8Array(
    await subtle().deriveBits(
      { name: 'X25519', public: await importPublic(recipientPublic) },
      ephemeral.privateKey,
      256
    )
  );
  const key = await boxKey(shared, ephemeralPublic, recipientPublic);
  const box = await secretboxSeal(bytesToBase64(plaintext), key);
  return `${SEALED_BOX_PREFIX}${bytesToBase64(ephemeralPublic)}:${box}`;
}

/** The inverse, with the recipient's raw private key. */
export async function openSealedBox(recipient: RawKeyPair, sealed: string): Promise<Bytes | null> {
  if (!sealed.startsWith(SEALED_BOX_PREFIX)) return null;
  const rest = sealed.slice(SEALED_BOX_PREFIX.length);
  const colon = rest.indexOf(':');
  if (colon <= 0) return null;
  const ephemeralPublic = base64ToBytes(rest.slice(0, colon));
  if (!ephemeralPublic || ephemeralPublic.length !== 32) return null;
  try {
    const shared = new Uint8Array(
      await subtle().deriveBits(
        { name: 'X25519', public: await importPublic(ephemeralPublic) },
        await importPrivate(recipient.privateKey),
        256
      )
    );
    const key = await boxKey(shared, ephemeralPublic, recipient.publicKey);
    return unwrapBytes(rest.slice(colon + 1), key);
  } catch {
    return null;
  }
}

/**
 * An Ed25519 signature checked against a raw public key — the delegate's
 * signed instance list (`../signing.ts` makes them). False for a bad
 * signature, a malformed key, or a browser without Ed25519 in WebCrypto:
 * every failure reads as "not verified", and the page asks the person.
 */
export async function verifyEd25519(
  publicKey: Uint8Array,
  message: Uint8Array,
  signature: Uint8Array
): Promise<boolean> {
  if (publicKey.length !== 32 || signature.length !== 64) return false;
  try {
    const key = await subtle().importKey('raw', toBytes(publicKey), { name: 'Ed25519' }, false, [
      'verify',
    ]);
    return await subtle().verify({ name: 'Ed25519' }, key, toBytes(signature), toBytes(message));
  } catch {
    return false;
  }
}
