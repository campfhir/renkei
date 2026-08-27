/**
 * @renkei/connector-fileshares — org-registered SMB/SFTP shares where each
 * person connects with their OWN credentials and the file server is the
 * authorization authority, the same delegation every OAuth connector
 * practices. Renkei stores connection details (admin), a sealed per-user
 * credential, and the person's LLM-exposure choice — never an ACL.
 *
 * The export surface is deliberate: the pure path grammar and types (safe
 * anywhere, including client components), the credential envelope, the
 * protocol backends, the service operation layer the fileshare worker
 * runs, and the Kysely store. Consumers in apps/web and the workers share
 * exactly this code so an answer is the same answer on every surface.
 */

export {
  isShareProtocol,
  isToolAccess,
  type EntryKind,
  type RawEntry,
  type ShareConnection,
  type ShareEntry,
  type ShareProtocol,
  type ShareSummary,
  type ToolAccess,
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
  resolveConnection,
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
  type EntryDetails,
  type FileContent,
  type FolderListing,
  type RelocationOutcome,
  type RemovePreview,
  type ResolvedConnection,
  type ServiceDeps,
  type ServiceError,
  type ShareRef,
  type SubjectTarget,
} from './service';

export {
  createShare,
  deleteConnection,
  deleteShare,
  getConnection,
  getShare,
  listConnectedShares,
  listShares,
  listSharesWithConnection,
  readConnectionCiphertext,
  resolveToolExposure,
  updateConnectionExposure,
  updateShare,
  upsertConnection,
  type ConnectedShare,
  type ConnectionInput,
  type ShareInput,
  type ShareRow,
  type ShareWithConnection,
  type StoreError,
  type ToolExposure,
} from './store';
