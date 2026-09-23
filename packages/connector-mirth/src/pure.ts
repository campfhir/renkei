/**
 * The browser-safe slice of the package: the domain types and the pure API
 * helpers — nothing that touches a socket, the database, or a credential.
 * Client components import THIS entry ('@renkei/connector-mirth/pure') so
 * their bundles never walk into kysely; the full barrel (index.ts) is for
 * server code and the Mirth worker.
 */

export {
  isEnvironmentLabel,
  MAX_ENVIRONMENT_LENGTH,
  type InstanceConnection,
  type MirthInstanceSummary,
} from './types';

export {
  DEFAULT_MIRTH_PERMISSIONS,
  MIRTH_PERMISSIONS,
  MIRTH_PERMISSION_GROUPS,
  MIRTH_PERMISSION_IDS,
  MIRTH_PERMISSION_PRESETS,
  isMirthPermission,
  mirthPermission,
  normalizePermissions,
  type MirthPermission,
} from './permissions';

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
  MIRTH_OPERATIONS,
  fillPath,
  pathParamNames,
  toMirthDate,
  type BodySpec,
  type OperationKind,
  type OperationSpec,
  type ParamSpec,
  type ParamType,
} from './operations';
