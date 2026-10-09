/**
 * The signed instance list: node signs, the browser half verifies the same
 * bytes, and anything moved, added or re-signed with another key fails.
 */

import { randomUUID } from 'node:crypto';
import { ed25519PublicKeyOf, generateEd25519KeyPair, signEd25519, verifyEd25519 } from './signing';
import { instanceListMessage } from './browser/instance-list';
import * as browser from './browser/webcrypto';

const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);

describe('Ed25519 signing', () => {
  it('signs in node and verifies in node and over WebCrypto', async () => {
    const pair = generateEd25519KeyPair();
    expect(ed25519PublicKeyOf(pair.privateKey).equals(pair.publicKey)).toBe(true);
    const message = Buffer.from('hello');
    const signature = signEd25519(pair.privateKey, message);
    expect(signature.byteLength).toBe(64);
    expect(verifyEd25519(pair.publicKey, message, signature)).toBe(true);
    expect(
      await browser.verifyEd25519(
        new Uint8Array(pair.publicKey),
        new Uint8Array(message),
        new Uint8Array(signature)
      )
    ).toBe(true);
    const other = generateEd25519KeyPair();
    expect(verifyEd25519(other.publicKey, message, signature)).toBe(false);
    expect(verifyEd25519(pair.publicKey, Buffer.from('hellp'), signature)).toBe(false);
    expect(
      await browser.verifyEd25519(
        new Uint8Array(other.publicKey),
        new Uint8Array(message),
        new Uint8Array(signature)
      )
    ).toBe(false);
    expect(
      await browser.verifyEd25519(new Uint8Array(3), new Uint8Array(message), new Uint8Array(64))
    ).toBe(false);
  });

  it('covers the instance list as one canonical message, whatever order the rows came in', async () => {
    const pair = generateEd25519KeyPair();
    const a = { id: randomUUID(), publicKey: Buffer.alloc(32, 1).toString('base64') };
    const b = { id: randomUUID(), publicKey: Buffer.alloc(32, 2).toString('base64') };
    expect(instanceListMessage([a, b])).toBe(instanceListMessage([b, a]));
    expect(instanceListMessage([a, b])).toMatch(/^renkei\/delegate-instances\/v1\n/);
    const signature = signEd25519(pair.privateKey, Buffer.from(instanceListMessage([a, b])));
    expect(
      await browser.verifyEd25519(
        new Uint8Array(pair.publicKey),
        utf8(instanceListMessage([b, a])),
        new Uint8Array(signature)
      )
    ).toBe(true);
    const planted = { id: randomUUID(), publicKey: Buffer.alloc(32, 9).toString('base64') };
    expect(
      await browser.verifyEd25519(
        new Uint8Array(pair.publicKey),
        utf8(instanceListMessage([a, b, planted])),
        new Uint8Array(signature)
      )
    ).toBe(false);
  });
});
