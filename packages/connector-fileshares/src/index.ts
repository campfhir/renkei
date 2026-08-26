/**
 * @renkei/connector-fileshares — org-registered SMB/SFTP shares where
 * Renkei, not a provider, is the ACL authority.
 *
 * The export surface is deliberate: the pure path/ACL engine (safe
 * anywhere, including client components for the admin UI's live path
 * preview), the credential envelope, the protocol backends, and the
 * Kysely store. Consumers in apps/web and the workers share exactly this
 * code so an ACL decision is the same decision on every surface.
 */

export {
  isAccessLevel,
  isShareProtocol,
  minAccess,
  atLeast,
  type AccessLevel,
  type AclContext,
  type EntryKind,
  type PathRule,
  type RawEntry,
  type ShareEntry,
  type ShareGrant,
  type ShareProtocol,
  type ShareSummary,
} from './types';

export {
  childPath,
  isBoundaryPrefix,
  joinUnder,
  normalizePath,
  parentPath,
  windowsToUnix,
  type PathError,
} from './paths';

export {
  annotateEntries,
  canListFolder,
  effectiveAccess,
  hasAllowedDescendant,
  layerAccess,
} from './acl';

export {
  decryptCredentials,
  encryptCredentials,
  parseShareCredentials,
  type CredentialError,
  type ShareCredentials,
} from './credentials';

export { openBackend, type BackendError, type ShareBackend } from './backend';

export {
  CONNECT_TIMEOUT_MS,
  OP_TIMEOUT_MS,
  TRANSFER_TIMEOUT_MS,
  withSessionLimits,
} from './limits';

export {
  resolveAccess,
  serviceAdminList,
  serviceAdminSearch,
  serviceListFolder,
  serviceMakeFolder,
  serviceMoveEntry,
  servicePreviewRemove,
  serviceReadFile,
  serviceRemoveEntry,
  serviceRenameEntry,
  serviceStatEntry,
  serviceTestConnection,
  serviceWriteFile,
  type ConnectionTest,
  type EntryDetails,
  type FileContent,
  type FolderListing,
  type RelocationOutcome,
  type RemovePreview,
  type ResolvedAccess,
  type SearchHit,
  type ServiceDeps,
  type ServiceError,
  type ShareRef,
  type SubjectTarget,
} from './service';

export {
  ACL_CACHE_TTL_MS,
  clearFileShareCache,
  createShare,
  deleteGrant,
  deleteRule,
  deleteShare,
  getAclContext,
  getShare,
  hasAnyGrant,
  listAllRules,
  listGrantedShares,
  listGrants,
  listRulePathsUnder,
  listRules,
  listShares,
  readCredentialCiphertext,
  updateShare,
  upsertGrant,
  upsertRule,
  type GrantedShare,
  type GrantRow,
  type RuleRow,
  type ShareInput,
  type ShareRow,
  type StoreError,
} from './store';
