/**
 * @renkei/user-keys — per-person encryption keys and the key store that
 * lets one chat be opened by several people (docs/user-encryption-keys-design.md).
 *
 * The bytes-only half (HKDF, wrapping, the envelopes) is @renkei/crypto;
 * this package owns the rows: a person's salt, a resource's key, and the
 * wrappings that say who may open it.
 */

export {
  getUserKek,
  ensureUserKek,
  rotateUserKek,
  shredUserKek,
  type UserKek,
  type KekError,
} from './kek';
export {
  createResourceKey,
  openResourceKey,
  ensureResourceKey,
  openResourceKeys,
  shareResourceKey,
  revokeResourceKey,
  deleteResourceKey,
  hasResourceKey,
  listResourceKeyHolders,
  pruneOrphanChatKeys,
  type ResourceKey,
  type ResourceKeyKind,
  type ResourceRef,
  type OpenKeyError,
} from './resource-keys';
export {
  sealForSubject,
  openForSubject,
  isUserSealed,
  type SealError,
  type OpenError,
} from './user-sealed';
