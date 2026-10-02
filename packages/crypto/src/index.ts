/**
 * @renkei/crypto — authenticated encryption for secrets held at rest.
 *
 * The secretbox seals provider tokens and OIDC client secrets with the
 * deployment key; every process that touches a grant comes through here.
 */

export { encrypt, decrypt, parseEncryptionKey, safeEqual, DecryptionError } from './secretbox';
export { sha256Hex, generateSecret } from './tokens';
export {
  contentEncryptionKey,
  encryptContent,
  decryptContent,
  isEncryptedContent,
  revealContent,
  CONTENT_ENVELOPE_PREFIX,
} from './content';
export {
  userKeyMaster,
  generateDataKey,
  generateUserKeySalt,
  deriveUserKek,
  wrapKey,
  unwrapKey,
  encryptWithResourceKey,
  decryptWithResourceKey,
  parseResourceEnvelope,
  isResourceEncrypted,
  sealForUser,
  openForUser,
  isUserSealed,
  RESOURCE_ENVELOPE_PREFIX,
  USER_ENVELOPE_PREFIX,
  DATA_KEY_BYTES,
  deriveOwnKek,
  deriveUnlockKey,
  kekVerifier,
  verifierMatches,
  OWN_KEY_PASSPHRASE_MIN_CHARS,
  OWN_KEY_PASSPHRASE_MAX_CHARS,
} from './keys';
