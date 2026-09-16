/**
 * The browser-safe slice of the package: the domain types and the pure API
 * helpers — nothing that touches a socket, the database, or a credential.
 * Client components import THIS entry ('@renkei/connector-mirth/pure') so
 * their bundles never walk into kysely; the full barrel (index.ts) is for
 * server code and the Mirth worker.
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
