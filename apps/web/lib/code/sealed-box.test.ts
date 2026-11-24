import nacl from 'tweetnacl';
import { openSealed, sealTo } from './sealed-box';

describe('a sealed box, as GitHub takes a secret', () => {
  const keys = nacl.box.keyPair();
  const publicKey = Buffer.from(keys.publicKey).toString('base64');

  it('opens for the key it was sealed to, and holds the value whole', () => {
    const sealed = sealTo(publicKey, 'pässword with\nlines = and "quotes"');
    expect(sealed).not.toBeNull();
    expect(openSealed(sealed!, keys)).toBe('pässword with\nlines = and "quotes"');
  });

  it('is the ephemeral key, then the box: 48 bytes more than the value', () => {
    const sealed = Buffer.from(sealTo(publicKey, 'abc')!, 'base64');
    expect(sealed.length).toBe(32 + 16 + 3);
  });

  it('seals the same value differently each time, and never shows it', () => {
    const one = sealTo(publicKey, 'the-same-secret')!;
    const two = sealTo(publicKey, 'the-same-secret')!;
    expect(one).not.toBe(two);
    expect(Buffer.from(one, 'base64').toString('latin1')).not.toContain('the-same-secret');
  });

  it('does not open for another key, or when changed on the way', () => {
    const sealed = sealTo(publicKey, 'secret')!;
    expect(openSealed(sealed, nacl.box.keyPair())).toBeNull();
    const bytes = Buffer.from(sealed, 'base64');
    bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 1;
    expect(openSealed(bytes.toString('base64'), keys)).toBeNull();
  });

  it('opens what libsodium itself sealed', () => {
    // crypto_box_seal('renkei', pk) from libsodium-wrappers 0.7.15, for this key pair.
    const pair = {
      publicKey: new Uint8Array(Buffer.from(LIBSODIUM.publicKey, 'base64')),
      secretKey: new Uint8Array(Buffer.from(LIBSODIUM.secretKey, 'base64')),
    };
    expect(openSealed(LIBSODIUM.sealed, pair)).toBe('renkei');
  });

  it('refuses a public key that is not one', () => {
    expect(sealTo('bm90IGEga2V5', 'x')).toBeNull();
  });
});

const LIBSODIUM = {
  publicKey: 'icsMG3tRAg5Xe4aJ5rs2PDGeo8jtwS+uhuOHGvo/UiM=',
  secretKey: 'oQc66DecNozIWJIUJkqym5Vi9ZLQhHQZWa5URnwqqzQ=',
  sealed: 'RN2w18eijz2ELzUETcOeU7N378rYYA0pYWPeQgA4cka8qycbQjb9L0d68oOQwzKFVKLSq8qT',
};
