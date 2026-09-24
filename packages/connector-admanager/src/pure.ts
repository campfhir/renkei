/**
 * The browser-safe slice of the package: the domain types and the pure API
 * helpers — nothing that touches a socket, the database, or a credential.
 * Client components import THIS entry ('@renkei/connector-admanager/pure')
 * so their bundles never walk into kysely; the full barrel (index.ts) is
 * for server code and the ADManager Plus worker.
 */

export {
  isEnvironmentLabel,
  isTemplateName,
  MAX_ENVIRONMENT_LENGTH,
  MAX_TEMPLATE_NAME_LENGTH,
  readInstanceSettings,
  type AdManagerInstanceSettings,
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
