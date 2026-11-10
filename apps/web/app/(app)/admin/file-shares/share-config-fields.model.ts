/**
 * The file-share draft both share forms edit (share-config-fields.tsx,
 * used by share-list.tsx and [shareId]/share-config-form.tsx), with no
 * network or React: an empty draft, what a protocol switch changes, which
 * fields each protocol shows, what Create or Save sends, and the live
 * verdicts on a root path and an SFTP host-key fingerprint — the same
 * functions the server validates with, so the preview is honest. Tested in
 * share-config-fields.model.test.ts.
 */

import {
  normalizeHostKeyFingerprint,
  normalizePath,
  windowsToUnix,
} from '@renkei/connector-fileshares/pure';

export type ShareProtocol = 'smb' | 'sftp';

export interface ShareDraft {
  name: string;
  protocol: ShareProtocol;
  host: string;
  port: string;
  shareName: string;
  rootPath: string;
  caseInsensitive: boolean;
  enabled: boolean;
  /** SFTP: the server's SHA256 host-key fingerprint; empty records it on first connection. */
  hostKeyFingerprint: string;
}

/** A new share: SMB at the root, matching case-insensitively as Windows does, on. */
export function emptyDraft(): ShareDraft {
  return {
    name: '',
    protocol: 'smb',
    host: '',
    port: '',
    shareName: '',
    rootPath: '/',
    caseInsensitive: true,
    enabled: true,
    hostKeyFingerprint: '',
  };
}

/**
 * A change to the draft. Switching protocol sets case matching to what
 * that kind of server does (SMB folds case, SFTP does not); the person can
 * still change it afterwards.
 */
export function editDraft(draft: ShareDraft, patch: Partial<ShareDraft>): ShareDraft {
  const next = { ...draft, ...patch };
  if (patch.protocol && patch.caseInsensitive === undefined) {
    next.caseInsensitive = patch.protocol === 'smb';
  }
  return next;
}

/** Which fields a protocol shows: a share name for SMB, a host key for SFTP. */
export function visibleFields(protocol: ShareProtocol): { shareName: boolean; hostKey: boolean } {
  return { shareName: protocol === 'smb', hostKey: protocol === 'sftp' };
}

export function portPlaceholder(protocol: ShareProtocol): string {
  return protocol === 'smb' ? '445 (default)' : '22 (default)';
}

export function rootPathPlaceholder(protocol: ShareProtocol): string {
  return protocol === 'smb' ? '\\ or a subfolder' : '/srv/data';
}

/** What the admin routes accept. */
export function draftPayload(draft: ShareDraft): Record<string, unknown> {
  return {
    name: draft.name,
    protocol: draft.protocol,
    host: draft.host,
    port: draft.port ? Number(draft.port) : null,
    shareName: draft.shareName || undefined,
    rootPath: draft.rootPath,
    caseInsensitive: draft.caseInsensitive,
    enabled: draft.enabled,
    // Only SFTP has a host key; an SMB share never sends one.
    hostKeyFingerprint: draft.protocol === 'sftp' ? draft.hostKeyFingerprint : null,
  };
}

/** Create needs a name and a host. */
export function canCreate(draft: ShareDraft, busy: boolean): boolean {
  return !busy && Boolean(draft.name.trim()) && Boolean(draft.host.trim());
}

/** The live verdict on a pasted fingerprint, with the same function the server validates with. */
export function hostKeyPreview(raw: string): { text: string; error: boolean } {
  const normalized = normalizeHostKeyFingerprint(raw);
  if (normalized === undefined) {
    return { text: 'Not a SHA256 fingerprint — paste what `ssh-keygen -lf` prints.', error: true };
  }
  if (normalized === null) {
    return {
      text: 'Empty: the key the server presents on the first successful connection is recorded here for you to confirm. Pin it now to refuse any other key from the start.',
      error: false,
    };
  }
  return {
    text: `Pinned as ${normalized}; a server presenting any other key is refused.`,
    error: false,
  };
}

/** The live translation the server will apply to the root path. */
export function pathPreview(raw: string): { text: string; error: boolean } {
  const normalized = normalizePath(windowsToUnix(raw || '/'));
  if (!normalized.ok)
    return { text: 'This path climbs upward ("..") and will be rejected.', error: true };
  return { text: `Stored as ${normalized.val}`, error: false };
}
