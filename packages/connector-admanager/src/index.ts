/**
 * @renkei/connector-admanager — operator-registered ManageEngine
 * ADManager Plus instances where each person connects with their OWN
 * ADManager Plus authtoken and ADManager Plus is the authorization
 * authority (its token scope and the technician's delegated rights), the
 * same delegation the Mirth and file-share connectors practice. Renkei
 * stores connection details (admin), a sealed per-user credential, and
 * the person's LLM-exposure choice — never an ACL.
 *
 * The export surface is deliberate: the pure API helpers and types (safe
 * anywhere, including client components), the credential envelope, the
 * Kysely store, and the worker's resolution step. All HTTP to an
 * ADManager Plus server happens in apps/worker-admanager, the dedicated
 * egress process, so the web app never dials a private host.
 */

export {
  isEnvironmentLabel,
  MAX_ENVIRONMENT_LENGTH,
  type InstanceConnection,
  type AdManagerInstanceSummary,
} from './types';

export {
  ADMANAGER_PERMISSIONS,
  ADMANAGER_PERMISSION_GROUPS,
  ADMANAGER_PERMISSION_IDS,
  ADMANAGER_PERMISSION_PRESETS,
  DEFAULT_ADMANAGER_PERMISSIONS,
  admanagerPermission,
  isAdManagerPermission,
  normalizePermissions,
  type AdManagerPermission,
} from './permissions';

export {
  combineFilters,
  filterClause,
  isHttpMethod,
  parseBaseUrl,
  validApiPath,
  type HttpMethod,
} from './api';

export {
  dedupeGroupNames,
  groupNamesFromDns,
  groupsPresent,
  groupsToAdd,
} from './groups';

export {
  decryptCredentials,
  encryptCredentials,
  parseAdManagerCredentials,
  type AdManagerCredentials,
  type CredentialError,
} from './credentials';

export {
  createInstance,
  deleteConnection,
  deleteInstance,
  getConnection,
  getInstance,
  listConnectedInstances,
  listInstances,
  listInstancesWithConnection,
  readConnectionCiphertext,
  resolveToolExposure,
  updateConnectionPermissions,
  updateInstance,
  upsertConnection,
  type ConnectedInstance,
  type ConnectionInput,
  type InstanceInput,
  type InstanceRow,
  type InstanceWithConnection,
  type StoreError,
  type ToolExposure,
} from './store';

export {
  resolveInstance,
  resolveTarget,
  type ResolveError,
  type ResolvedTarget,
  type SubjectTarget,
} from './resolve';
