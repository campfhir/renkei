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
