/**
 * The protocol seam. Everything above (tools, routes, admin browse) speaks
 * this interface; SMB and SFTP are one file each behind it, so a library
 * swap — say v9u-smb2 for an smbclient wrapper — touches nothing else.
 *
 * Paths passed in are SHARE-RELATIVE normalized Unix paths; each backend
 * joins them under the share's root_path itself (via joinUnder, which
 * re-verifies containment — the last checkpoint before a socket).
 *
 * Errors are a tag union because callers must tell "the server said no"
 * ('not_found', 'access_denied') from "the call broke" ('connection',
 * 'timeout', 'protocol') — the same rule every connector client here
 * keeps. 'too_large' is its own tag so tools can phrase it honestly
 * instead of as a failure.
 */

import type { Result } from '@campfhir/safe-functions/types';
import type { ShareCredentials } from './credentials';
import type { RawEntry, ShareSummary } from './types';

export type BackendError =
  | 'not_found'
  | 'access_denied'
  | 'connection'
  | 'timeout'
  | 'too_large'
  | 'exists'
  | 'not_empty'
  | 'protocol';

export interface ShareBackend {
  list(path: string): Promise<Result<RawEntry[], BackendError>>;
  stat(path: string): Promise<Result<RawEntry, BackendError>>;
  /** Reads at most maxBytes; a larger file is a 'too_large' error, not a truncation. */
  read(path: string, maxBytes: number): Promise<Result<Uint8Array, BackendError>>;
  write(path: string, bytes: Uint8Array): Promise<Result<void, BackendError>>;
  mkdir(path: string): Promise<Result<void, BackendError>>;
  /**
   * Remove one entry. `kind` comes from a prior stat and selects the
   * protocol primitive; directory removal is NON-recursive — a non-empty
   * directory is a 'not_empty' error, never a tree delete.
   */
  remove(path: string, kind: 'file' | 'dir'): Promise<Result<void, BackendError>>;
  /**
   * Rename/move within the share (one primitive serves both). Never
   * clobbers: an existing destination is an 'exists' error.
   */
  rename(fromPath: string, toPath: string): Promise<Result<void, BackendError>>;
  close(): Promise<void>;
}

/**
 * Open a session for a share with its stored credential. A protocol
 * mismatch between share row and credential document is a typed error here
 * rather than a connect-time mystery.
 */
export async function openBackend(
  share: ShareSummary,
  credentials: ShareCredentials
): Promise<Result<ShareBackend, BackendError>> {
  if (share.protocol === 'smb') {
    const { openSmbBackend } = await import('./smb');
    return openSmbBackend(share, credentials);
  }
  const { openSftpBackend } = await import('./sftp');
  return openSftpBackend(share, credentials);
}
