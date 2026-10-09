/**
 * Sealed boxes, and the browser half speaking the same wire: what node
 * seals the browser code (over node's own WebCrypto) opens, and the other
 * way round, for the secretbox, the wrapped-key form and the sealed box.
 */

import { randomBytes } from 'node:crypto';
import {
  generateX25519KeyPair,
  openSealedBox,
  sealToPublicKey,
  x25519PublicKeyOf,
  isSealedBox,
} from './sealed-box';
import { encrypt, decrypt } from './secretbox';
import { wrapKey, unwrapKey } from './keys';
import * as browser from './browser/webcrypto';
import {
  formatUserKey,
  parseUserKey,
  normalizeDeviceCode,
  deviceCodeOf as browserDeviceCodeOf,
} from './browser/key-display';
import { deviceCodeOf } from './device-code';
import { bytesToBase64, base64ToBytes } from './browser/encoding';

const bytes = (buffer: Buffer): Uint8Array => new Uint8Array(buffer);

describe('sealed boxes (node)', () => {
  it('open only with the recipient keypair', () => {
    const alice = generateX25519KeyPair();
    const mallory = generateX25519KeyPair();
    const secret = randomBytes(32);
    const sealed = sealToPublicKey(alice.publicKey, secret);
    expect(isSealedBox(sealed)).toBe(true);
    expect(sealToPublicKey(alice.publicKey, secret)).not.toBe(sealed); // fresh ephemeral each time
    const opened = openSealedBox(alice, sealed);
    expect(opened.ok && opened.val.equals(secret)).toBe(true);
    expect(openSealedBox(mallory, sealed).ok).toBe(false);
    expect(
      openSealedBox(
        alice,
        sealed.replace(/.$/, (c) => (c === 'A' ? 'B' : 'A'))
      ).ok
    ).toBe(false);
    expect(openSealedBox(alice, 'v1.not.a.box').ok).toBe(false);
  });

  it('recovers a public key from its private half', () => {
    const pair = generateX25519KeyPair();
    expect(x25519PublicKeyOf(pair.privateKey).equals(pair.publicKey)).toBe(true);
  });
});

describe('the browser half speaks the node wire', () => {
  it('secretbox: each side opens what the other sealed', async () => {
    const key = randomBytes(32);
    const fromNode = encrypt('hello from node', key);
    expect(await browser.secretboxOpen(fromNode, bytes(key))).toBe('hello from node');
    const fromBrowser = await browser.secretboxSeal('hello from the page', bytes(key));
    const opened = decrypt(fromBrowser, key);
    expect(opened.ok && opened.val).toBe('hello from the page');
    expect(await browser.secretboxOpen(fromNode, bytes(randomBytes(32)))).toBeNull();
  });

  it('wrapped keys: the grant-row form round-trips both ways', async () => {
    const kek = randomBytes(32);
    const dek = randomBytes(32);
    const unwrapped = await browser.unwrapBytes(wrapKey(dek, kek), bytes(kek));
    expect(unwrapped && Buffer.from(unwrapped).equals(dek)).toBe(true);
    const wrappedInBrowser = await browser.wrapBytes(bytes(dek), bytes(kek));
    const inNode = unwrapKey(wrappedInBrowser, kek);
    expect(inNode.ok && inNode.val.equals(dek)).toBe(true);
  });

  it('sealed boxes: the browser seals to a node keypair and node seals to a browser keypair', async () => {
    const instance = generateX25519KeyPair();
    const userKey = randomBytes(32);
    const sealedByPage = await browser.sealToPublicKey(bytes(instance.publicKey), bytes(userKey));
    const openedByDelegate = openSealedBox(instance, sealedByPage);
    expect(openedByDelegate.ok && openedByDelegate.val.equals(userKey)).toBe(true);

    const device = await browser.generateKeyPair();
    expect(device.publicKey.length).toBe(32);
    expect(device.privateKey.length).toBe(32);
    const sealedByNode = sealToPublicKey(Buffer.from(device.publicKey), userKey);
    const openedByPage = await browser.openSealedBox(device, sealedByNode);
    expect(openedByPage && Buffer.from(openedByPage).equals(userKey)).toBe(true);
    const other = await browser.generateKeyPair();
    expect(await browser.openSealedBox(other, sealedByNode)).toBeNull();
    // Node's view of the browser keypair agrees on the public half.
    expect(
      x25519PublicKeyOf(Buffer.from(device.privateKey)).equals(Buffer.from(device.publicKey))
    ).toBe(true);
  });

  it('base64 helpers agree with Buffer', () => {
    for (const length of [0, 1, 2, 3, 31, 32, 33]) {
      const raw = randomBytes(length);
      expect(bytesToBase64(bytes(raw))).toBe(raw.toString('base64'));
      const back = base64ToBytes(raw.toString('base64'));
      expect(back && Buffer.from(back).equals(raw)).toBe(true);
    }
    expect(base64ToBytes('not base64!')).toBeNull();
  });
});

describe('the written-down key', () => {
  it('formats as fourteen groups and parses back, forgiving case and separators', () => {
    const key = randomBytes(32);
    const shown = formatUserKey(bytes(key));
    expect(shown).toMatch(/^([a-z2-7]{4}-){13}[a-z2-7]{4}$/);
    const parsed = parseUserKey(shown);
    expect(parsed.ok && Buffer.from(parsed.bytes).equals(key)).toBe(true);
    const sloppy = parseUserKey(shown.toUpperCase().replace(/-/g, ' '));
    expect(sloppy.ok && Buffer.from(sloppy.bytes).equals(key)).toBe(true);
  });

  it('catches a typo through the checksum, and names the other failures', () => {
    const shown = formatUserKey(bytes(randomBytes(32)));
    const flipped = shown[0] === 'a' ? `b${shown.slice(1)}` : `a${shown.slice(1)}`;
    expect(parseUserKey(flipped)).toEqual({ ok: false, error: 'CHECKSUM' });
    expect(parseUserKey(shown.slice(0, -1))).toEqual({ ok: false, error: 'WRONG_LENGTH' });
    expect(parseUserKey(`1${shown.slice(1)}`)).toEqual({ ok: false, error: 'BAD_CHARACTER' });
  });

  it('gives a device a ten-character code from the digest of its public key, the same in node and the browser', async () => {
    for (let i = 0; i < 8; i += 1) {
      const key = bytes(randomBytes(32));
      const code = deviceCodeOf(key);
      expect(code).toMatch(/^[A-Z2-7]{5}-[A-Z2-7]{5}$/);
      expect(await browserDeviceCodeOf(key)).toBe(code);
      // Every bit of the key weighs on the code, not only its first bytes.
      const flipped = Uint8Array.from(key);
      flipped[31] ^= 1;
      expect(deviceCodeOf(flipped)).not.toBe(code);
      expect(normalizeDeviceCode(code.toLowerCase().replace('-', ' '))).toBe(code);
    }
    expect(normalizeDeviceCode('ABC-DEF')).toBeNull();
    expect(normalizeDeviceCode('ABCDE-FGH1J')).toBeNull();
  });
});
