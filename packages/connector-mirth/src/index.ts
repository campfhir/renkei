/**
 * @renkei/connector-mirth — operator-registered Mirth Connect (NextGen
 * Connect 4.5.2) instances where each person connects with their OWN Mirth
 * account and the Mirth server is the authorization authority, the same
 * delegation the file-share connector practices. Renkei stores connection
 * details (admin), a sealed per-user credential, and the person's
 * LLM-exposure choice — never an ACL.
 *
 * The export surface is deliberate: the pure API helpers and types (safe
 * anywhere, including client components), the credential envelope, the
 * Kysely store, and the worker's resolution step. All HTTP to a Mirth
 * server happens in apps/worker-mirth, the dedicated egress process, so
 * the web app never dials a private host.
 */

export {
  isEnvironmentLabel,
  isToolAccess,
  MAX_ENVIRONMENT_LENGTH,
  type InstanceConnection,
  type MirthInstanceSummary,
  type ToolAccess,
} from './types';

export {
  MIRTH_API_PREFIX,
  asArray,
  isDestructiveRequest,
  isHttpMethod,
  isRecord,
  parseBaseUrl,
  textOf,
  unwrapList,
  unwrapMap,
  validApiPath,
  type HttpMethod,
} from './api';

export {
  decryptCredentials,
  encryptCredentials,
  parseMirthCredentials,
  type CredentialError,
  type MirthCredentials,
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
  updateConnectionExposure,
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
