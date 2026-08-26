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
