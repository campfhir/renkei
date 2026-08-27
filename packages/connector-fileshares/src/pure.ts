/**
 * The browser-safe slice of the package: the path grammar and the domain
 * types — nothing that touches a socket, the database, or a credential.
 * Client components import THIS entry ('@renkei/connector-fileshares/pure')
 * so their bundles never walk into the protocol backends; the full barrel
 * (index.ts) is for server code and the fileshare worker.
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
