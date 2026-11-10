/**
 * Shares and per-user connections, through the data store
 * (`getDataStore().fileShares`): the store keeps and returns rows, this
 * file validates them into the connector's types. Everything returns
 * Result and every uncertain outcome denies: a storage error is an error
 * (not "no shares"), and a row that fails validation poisons the read
 * rather than being skipped.
 *
 * There is no authorization model here. Admins register a share's
 * connection details; each person stores their OWN credential for it (the
 * connection row), and the file server is the sole authority on what that
 * account may do. What a connection row does carry besides the sealed
 * credential is the person's LLM-exposure choice — how much of their own
 * access the MCP tools may use — which the tool layer reads and the worker
 * deliberately does not.
 */

import { getDataStore, type FileShareRecord } from '@renkei/db';
import { ok, err, wrapAsync } from '@campfhir/safe-functions/helpers';
import type { Result } from '@campfhir/safe-functions/types';
import { isShareProtocol, isToolAccess } from './types';
import type { ShareConnection, ShareSummary } from './types';
import { isRecord } from '@renkei/guards';

export type StoreError = 'DB_ERROR' | 'MALFORMED_ROW';

export interface ShareRow {
  summary: ShareSummary;
  settings: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

function summaryFromRecord(row: FileShareRecord): ShareSummary | null {
  if (!isShareProtocol(row.protocol)) return null;
  return {
    id: row.id,
    name: row.name,
    protocol: row.protocol,
    host: row.host,
    port: row.port,
    shareName: row.shareName,
    rootPath: row.rootPath,
    caseInsensitive: row.caseInsensitive,
    enabled: row.enabled,
    hostKeyFingerprint: row.hostKeyFingerprint,
  };
}

function connectionFromRecord(row: {
  username: string;
  toolAccess: string;
  allowDelete: boolean;
}): Result<ShareConnection, StoreError> {
  if (!isToolAccess(row.toolAccess)) return err('MALFORMED_ROW' as const);
  return ok({
    username: row.username,
    toolAccess: row.toolAccess,
    allowDelete: row.allowDelete === true,
  });
}

function rowFromRecord(row: FileShareRecord): ShareRow | null {
  const summary = summaryFromRecord(row);
  if (!summary) return null;
  return {
    summary,
    settings: isRecord(row.settings) ? { ...row.settings } : {},
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** The data store's name-uniqueness refusal (the only unique key a write here can hit). */
function isDuplicateName(cause: unknown): boolean {
  return isRecord(cause) && cause.code === '23505';
}

// ---------------------------------------------------------------------------
// Per-user connections — the caller's own credential + exposure choice.
// ---------------------------------------------------------------------------

export interface ConnectedShare {
  share: ShareSummary;
  connection: ShareConnection;
}

/** Every enabled share, with this subject's connection where one exists. */
export interface ShareWithConnection {
  share: ShareSummary;
  connection: ShareConnection | null;
}

/**
 * The connectors-page view: all enabled shares an admin has registered,
 * marked with whether THIS person has connected each. Listing a share's
 * existence to everyone is deliberate — discovery is not a secret in this
 * model, credentials are the gate.
 */
export async function listSharesWithConnection(
  subject: string
): Promise<Result<ShareWithConnection[], StoreError>> {
  const rows = await wrapAsync(
    () => getDataStore().fileShares.listWithConnection(subject),
    'DB_ERROR' as const
  );
  if (!rows.ok) return rows;

  const shares: ShareWithConnection[] = [];
  for (const row of rows.val) {
    const summary = summaryFromRecord(row.share);
    if (!summary) return err('MALFORMED_ROW' as const);
    if (!row.connection) {
      shares.push({ share: summary, connection: null });
      continue;
    }
    const connection = connectionFromRecord(row.connection);
    if (!connection.ok) return connection;
    shares.push({ share: summary, connection: connection.val });
  }
  return ok(shares);
}

/** The shares this subject has connected — what the tools and browser list. */
export async function listConnectedShares(
  subject: string
): Promise<Result<ConnectedShare[], StoreError>> {
  const all = await listSharesWithConnection(subject);
  if (!all.ok) return all;
  return ok(
    all.val.flatMap((entry) =>
      entry.connection ? [{ share: entry.share, connection: entry.connection }] : []
    )
  );
}

/** One connection's exposure row (no credential), or null if not connected. */
export async function getConnection(
  shareId: string,
  subject: string
): Promise<Result<ShareConnection | null, StoreError>> {
  const row = await wrapAsync(
    () => getDataStore().fileShares.getConnection(shareId, subject),
    'DB_ERROR' as const
  );
  if (!row.ok) return row;
  if (!row.val) return ok(null);
  return connectionFromRecord(row.val);
}

/** The sealed credential for one connection — only the worker decrypts it. */
export async function readConnectionCiphertext(
  shareId: string,
  subject: string
): Promise<Result<string | null, StoreError>> {
  const row = await wrapAsync(
    () => getDataStore().fileShares.getConnection(shareId, subject),
    'DB_ERROR' as const
  );
  if (!row.ok) return row;
  return ok(row.val?.encryptedCredentials ?? null);
}

export interface ConnectionInput {
  /** The sealed credential document (encryptCredentials output). */
  encryptedCredentials: string;
  /** The account name, for display on the connectors card. */
  username: string;
  toolAccess: ShareConnection['toolAccess'];
  allowDelete: boolean;
}

/** Store or replace this subject's connection to a share. */
export async function upsertConnection(
  shareId: string,
  subject: string,
  input: ConnectionInput
): Promise<Result<void, StoreError>> {
  const written = await wrapAsync(
    () =>
      getDataStore().fileShares.upsertConnection(shareId, subject, {
        encryptedCredentials: input.encryptedCredentials,
        username: input.username,
        toolAccess: input.toolAccess,
        allowDelete: input.allowDelete,
      }),
    'DB_ERROR' as const
  );
  if (!written.ok) return written;
  return ok();
}

/** Change only the exposure choice, keeping the stored credential. */
export async function updateConnectionExposure(
  shareId: string,
  subject: string,
  toolAccess: ShareConnection['toolAccess'],
  allowDelete: boolean
): Promise<Result<boolean, StoreError>> {
  const updated = await wrapAsync(
    () =>
      getDataStore().fileShares.updateConnectionExposure(shareId, subject, {
        toolAccess,
        allowDelete,
      }),
    'DB_ERROR' as const
  );
  if (!updated.ok) return updated;
  return ok(updated.val > 0);
}

/** Remove this subject's connection (credential included). */
export async function deleteConnection(
  shareId: string,
  subject: string
): Promise<Result<boolean, StoreError>> {
  const deleted = await wrapAsync(
    () => getDataStore().fileShares.deleteConnection(shareId, subject),
    'DB_ERROR' as const
  );
  if (!deleted.ok) return deleted;
  return ok(deleted.val > 0);
}

/** Which tool families this subject's connections enable — see registry. */
export interface ToolExposure {
  /** Any connection at all: the read tools. */
  read: boolean;
  /** Any connection exposing read/write: the write tools. */
  write: boolean;
  /** Any read/write connection that also opted into delete. */
  del: boolean;
}

/**
 * The availability question the MCP transport asks per connection setup:
 * which fileshare tool families should register for this subject?
 */
export async function resolveToolExposure(
  subject: string
): Promise<Result<ToolExposure, StoreError>> {
  const rows = await wrapAsync(
    () => getDataStore().fileShares.connectionExposures(subject),
    'DB_ERROR' as const
  );
  if (!rows.ok) return rows;

  const exposure: ToolExposure = { read: false, write: false, del: false };
  for (const row of rows.val) {
    if (!isToolAccess(row.toolAccess)) return err('MALFORMED_ROW' as const);
    exposure.read = true;
    const write = row.toolAccess === 'read_write';
    exposure.write = exposure.write || write;
    exposure.del = exposure.del || (write && row.allowDelete === true);
  }
  return ok(exposure);
}

// ---------------------------------------------------------------------------
// Admin accessors — used only behind ROLE_OPERATOR routes.
// ---------------------------------------------------------------------------

export async function listShares(): Promise<Result<ShareRow[], StoreError>> {
  const rows = await wrapAsync(() => getDataStore().fileShares.list(), 'DB_ERROR' as const);
  if (!rows.ok) return rows;

  const shares: ShareRow[] = [];
  for (const record of rows.val) {
    const row = rowFromRecord(record);
    if (!row) return err('MALFORMED_ROW' as const);
    shares.push(row);
  }
  return ok(shares);
}

export async function getShare(shareId: string): Promise<Result<ShareRow | null, StoreError>> {
  const record = await wrapAsync(() => getDataStore().fileShares.get(shareId), 'DB_ERROR' as const);
  if (!record.ok) return record;
  if (!record.val) return ok(null);
  const row = rowFromRecord(record.val);
  if (!row) return err('MALFORMED_ROW' as const);
  return ok(row);
}

export interface ShareInput {
  name: string;
  protocol: 'smb' | 'sftp';
  host: string;
  port: number | null;
  shareName: string | null;
  rootPath: string;
  caseInsensitive: boolean;
  enabled: boolean;
  /**
   * The pinned SFTP host key (normalized `SHA256:...`); null clears it, so
   * the next successful connection records the server's key afresh
   * (trust-on-first-use). Always null for SMB.
   */
  hostKeyFingerprint: string | null;
}

export async function createShare(
  input: ShareInput
): Promise<Result<string, StoreError | 'DUPLICATE_NAME'>> {
  const inserted = await wrapAsync(
    () => getDataStore().fileShares.create(input),
    'DB_ERROR' as const
  );
  if (!inserted.ok) {
    return isDuplicateName(inserted.err.cause) ? err('DUPLICATE_NAME' as const) : inserted;
  }
  return ok(inserted.val);
}

export async function updateShare(
  shareId: string,
  input: ShareInput
): Promise<Result<boolean, StoreError | 'DUPLICATE_NAME'>> {
  const updated = await wrapAsync(
    () => getDataStore().fileShares.update(shareId, input),
    'DB_ERROR' as const
  );
  if (!updated.ok) {
    return isDuplicateName(updated.err.cause) ? err('DUPLICATE_NAME' as const) : updated;
  }
  return ok(updated.val > 0);
}

/**
 * Trust-on-first-use: record the SSH host key a share's server presented
 * on the first successful connection — only where none is pinned yet, so
 * a race between two first connections cannot replace what the first one
 * saw, and an admin's explicit pin is never overwritten. True when this
 * call did the recording.
 */
export async function recordHostKeyFingerprint(
  shareId: string,
  fingerprint: string
): Promise<Result<boolean, StoreError>> {
  const updated = await wrapAsync(
    () => getDataStore().fileShares.recordHostKeyFingerprint(shareId, fingerprint),
    'DB_ERROR' as const
  );
  if (!updated.ok) return updated;
  return ok(updated.val > 0);
}

export async function deleteShare(shareId: string): Promise<Result<boolean, StoreError>> {
  const deleted = await wrapAsync(
    () => getDataStore().fileShares.delete(shareId),
    'DB_ERROR' as const
  );
  if (!deleted.ok) return deleted;
  return ok(deleted.val > 0);
}
