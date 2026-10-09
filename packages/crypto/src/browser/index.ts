/**
 * @renkei/crypto/browser — the key code a page runs, over WebCrypto and
 * pure functions only (no node:crypto, no Buffer). Everything here has a
 * node twin in the package root with the same wire format.
 */

export {
  base64ToBytes,
  bytesToBase64,
  bytesToUtf8,
  utf8ToBytes,
  concatBytes,
  bytesEqual,
  toBytes,
  type Bytes,
} from './encoding';
export {
  formatUserKey,
  parseUserKey,
  deviceCodeOf,
  deviceCodeFromDigest,
  normalizeDeviceCode,
  DEVICE_CODE_CHARS,
  USER_KEY_BYTES,
  type UserKeyParseError,
} from './key-display';
export {
  randomBytes,
  secretboxSeal,
  secretboxOpen,
  wrapBytes,
  unwrapBytes,
  generateKeyPair,
  sealToPublicKey,
  openSealedBox,
  SEALED_BOX_PREFIX,
  type RawKeyPair,
} from './webcrypto';
