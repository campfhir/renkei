/**
 * The node half of the device code (`browser/key-display.ts` has the
 * WebCrypto half and the shared formatting): SHA-256 of the asking
 * device's ephemeral public key, first ten base32 characters, grouped in
 * fives. The web app's devices route computes it here when a device asks;
 * the asking page computes the same from the key it generated, and the
 * approving device types what it reads off the asker's screen.
 */

import { createHash } from 'node:crypto';
import { deviceCodeFromDigest } from './browser/key-display';

export function deviceCodeOf(publicKey: Uint8Array): string {
  return deviceCodeFromDigest(new Uint8Array(createHash('sha256').update(publicKey).digest()));
}
