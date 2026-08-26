/**
 * The browser-safe slice of the package: the path grammar, the pure ACL
 * evaluator, and the domain types — nothing that touches a socket, the
 * database, or a credential. The admin UI's live path preview imports
 * THIS entry ('@renkei/connector-fileshares/pure') so the client bundle
 * never walks into the protocol backends; the full barrel (index.ts) is
 * for server code and the fileshare worker.
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
