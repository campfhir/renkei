/**
 * The domain vocabulary for org file shares.
 *
 * Renkei deliberately holds NO authorization model of its own here: every
 * person connects a share with their own credentials, and the file server
 * decides what that account may read, write or delete — the same delegation
 * every other connector practices with OAuth. What Renkei does keep is the
 * person's LLM-exposure choice (`ToolAccess` + delete consent): a narrowing
 * of what the MCP tools may attempt with credentials the person already
 * holds, never a widening.
 */

export type ShareProtocol = 'smb' | 'sftp';

export function isShareProtocol(value: unknown): value is ShareProtocol {
  return value === 'smb' || value === 'sftp';
}

/** A share as admins register it — connection details only, no credentials. */
export interface ShareSummary {
  id: string;
  name: string;
  protocol: ShareProtocol;
  host: string;
  /** NULL means the protocol default (445 / 22), applied at connect time. */
  port: number | null;
  /** SMB share component of \\host\share; null for SFTP. */
  shareName: string | null;
  /** Normalized base path all user paths resolve under. */
  rootPath: string;
  caseInsensitive: boolean;
  enabled: boolean;
}

/**
 * What a person lets their LLM do on a connected share. 'read' is the
 * floor — a connection with no read exposure would be a connection with no
 * point — and delete is its own switch because file-server deletion is
 * permanent: write and delete may be one permission on the server, but they
 * deserve separate consent at the model boundary.
 */
export type ToolAccess = 'read' | 'read_write';

export function isToolAccess(value: unknown): value is ToolAccess {
  return value === 'read' || value === 'read_write';
}

/** One person's connection to one share (credentials stored separately). */
export interface ShareConnection {
  /** The account name the person connected with — display only, no secret. */
  username: string;
  toolAccess: ToolAccess;
  allowDelete: boolean;
}

export type EntryKind = 'file' | 'dir';

/** What a protocol backend reports for one directory entry. */
export interface RawEntry {
  name: string;
  kind: EntryKind;
  size: number | null;
  modifiedAt: Date | null;
  /**
   * Stat-only extras, absent from listings and null where the protocol
   * has nothing to say: SFTP reports numeric uid/gid but no birth time;
   * SMB reports a creation time but no owner without a security query.
   */
  createdAt?: Date | null;
  owner?: string | null;
  group?: string | null;
}

/** A directory entry with its share-rooted path. */
export interface ShareEntry extends RawEntry {
  path: string;
}
