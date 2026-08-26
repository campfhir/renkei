/**
 * The domain vocabulary for Renkei-governed file shares.
 *
 * Access is a three-level ladder, not a bitmask, because every question the
 * connector answers reduces to "how much of the ladder does this caller hold
 * at this path" — and a total order is what lets two independent rule layers
 * compose by minimum, the only composition that can narrow but never widen
 * (the same invariant `@renkei/capability-registry` keeps for tools).
 */

export type AccessLevel = 'none' | 'read' | 'read_write';

const LEVEL_ORDER: Record<AccessLevel, number> = { none: 0, read: 1, read_write: 2 };

export function isAccessLevel(value: unknown): value is AccessLevel {
  return value === 'none' || value === 'read' || value === 'read_write';
}

/** The narrowing composition: the lesser of two levels. */
export function minAccess(a: AccessLevel, b: AccessLevel): AccessLevel {
  return LEVEL_ORDER[a] <= LEVEL_ORDER[b] ? a : b;
}

export function atLeast(level: AccessLevel, floor: AccessLevel): boolean {
  return LEVEL_ORDER[level] >= LEVEL_ORDER[floor];
}

export type ShareProtocol = 'smb' | 'sftp';

export function isShareProtocol(value: unknown): value is ShareProtocol {
  return value === 'smb' || value === 'sftp';
}

/** A share as the ACL engine sees it — no credentials, no timestamps. */
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
  /** The share-wide layer's implicit rule at '/'. */
  maxAccess: Exclude<AccessLevel, 'none'>;
  enabled: boolean;
  /** False until an admin has stored a credential; unusable while false. */
  hasCredentials: boolean;
}

export interface ShareGrant {
  subject: string;
  /** The per-user layer's implicit rule at '/'. 'none' = carve-in only. */
  defaultAccess: AccessLevel;
}

/** One rule of a layer; which layer is decided by which list it sits in. */
export interface PathRule {
  /** Normalized Unix path, case-preserved. */
  path: string;
  access: AccessLevel;
}

/**
 * Everything the pure evaluator needs to answer for one (share, subject)
 * pair. Built by the store in one query; absence of the whole context —
 * no share, no grant — is the caller's signal to deny discovery itself.
 */
export interface AclContext {
  share: ShareSummary;
  grant: ShareGrant;
  /** Rules with subject NULL — the admin's envelope for every grantee. */
  shareRules: readonly PathRule[];
  /** Rules for this subject — can only narrow further. */
  userRules: readonly PathRule[];
}

export type EntryKind = 'file' | 'dir';

/** What a protocol backend reports for one directory entry. */
export interface RawEntry {
  name: string;
  kind: EntryKind;
  size: number | null;
  modifiedAt: Date | null;
}

/**
 * A directory entry after the ACL pass. `access` is what the caller may do
 * with the entry itself; 'traverse' marks a directory whose own content is
 * closed but which sits on the path to a deeper allow rule — visible so the
 * grant is reachable by browsing, not only by knowing the full path.
 */
export interface ShareEntry extends RawEntry {
  path: string;
  access: 'read' | 'read_write' | 'traverse';
}
