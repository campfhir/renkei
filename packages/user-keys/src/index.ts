/**
 * @renkei/user-keys — keys a person holds, and the key store that lets
 * one chat be opened by several people (docs/delegate-key-design.md).
 *
 * The bytes-only half (wrapping, sealed boxes, the envelopes) is
 * @renkei/crypto; this package owns the rows: a person's public key and
 * wrapped keys, the delegations sealed to a delegate instance, a
 * resource's key, and the wrappings that say who may open it. Nothing
 * here derives a key: every open goes through a delegation the browser
 * sealed to the running delegate instance (keyring.ts).
 */

export { createKeyVault, keyVault, setKeyVault, type KeyVault } from './vault';
export {
  getKeyRing,
  readKeyRow,
  delegationStatus,
  liveInstances,
  INSTANCE_LIVE_MS,
  type KeyRing,
  type KeyScope,
  type KeyError,
  type DelegationStatus,
  type LiveInstance,
} from './keyring';
export {
  enroll,
  storeDelegations,
  revokeAutomation,
  rotateUserKey,
  shredUserKey,
  enrollmentCensus,
  AUTOMATION_WINDOW_MAX_MS,
  AUTOMATION_WINDOW_DEFAULT_MS,
  type EnrollInput,
  type EnrollError,
  type EnrollmentView,
  type DelegationInput,
  type DelegateError,
  type RotateInput,
  type RotateError,
  type SealedDelegation,
} from './enrollment';
export {
  createResourceKey,
  openResourceKey,
  ensureResourceKey,
  openResourceKeys,
  grantAutomationAccess,
  shareResourceKey,
  wrapResourceKeyUnder,
  revokeResourceKey,
  deleteResourceKey,
  hasResourceKey,
  listResourceKeyHolders,
  pruneOrphanResourceKeys,
  type ResourceKey,
  type ResourceKeyKind,
  type ResourceRef,
  type HolderKind,
  type OpenKeyError,
  type ShareKeyError,
  type CreateKeyOptions,
  type ResourceKeyHolder,
} from './resource-keys';
export {
  sealForSubject,
  openForSubject,
  isUserSealed,
  PRIVATE_ENVELOPE_PREFIX,
  type SealScope,
  type SealError,
  type OpenError,
} from './user-sealed';
export {
  legacyMasterAvailable,
  legacyManagedKek,
  legacySealForSubject,
  legacyEnsureResourceKey,
  legacyShareResourceKey,
} from './legacy';
