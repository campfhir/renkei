/**
 * Kysely accessors for shares and per-user connections — the only file that
 * knows the table shapes. Everything returns Result and every uncertain
 * outcome denies: a DB error is an error (not "no shares"), and a row that
 * fails validation poisons the read rather than being skipped.
 *
 * There is no authorization model here. Admins register a share's
 * connection details; each person stores their OWN credential for it (the
 * connection row), and the file server is the sole authority on what that
 * account may do. What a connection row does carry besides the sealed
 * credential is the person's LLM-exposure choice — how much of their own
 * access the MCP tools may use — which the tool layer reads and the worker
 * deliberately does not.
 */

import type { Kysely } from 'kysely';
import type { DB } from '@renkei/db';
import { ok, err, wrapAsync } from '@campfhir/safe-functions/helpers';
import type { Result } from '@campfhir/safe-functions/types';
import { isShareProtocol, isToolAccess } from './types';
import type { ShareConnection, ShareSummary } from './types';

export type StoreError = 'DB_ERROR' | 'MALFORMED_ROW';

export interface ShareRow {
  summary: ShareSummary;
  settings: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

interface RawShare {
  id: string;
  name: string;
  protocol: string;
  host: string;
  port: number | null;
  share_name: string | null;
  root_path: string;
  case_insensitive: boolean;
  enabled: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function summaryFromRow(row: RawShare): ShareSummary | null {
  if (!isShareProtocol(row.protocol)) return null;
  return {
    id: row.id,
    name: row.name,
    protocol: row.protocol,
    host: row.host,
    port: row.port,
    shareName: row.share_name,
    rootPath: row.root_path,
    caseInsensitive: row.case_insensitive,
    enabled: row.enabled,
  };
}

const SHARE_COLUMNS = [
  'file_shares.id',
  'file_shares.name',
  'file_shares.protocol',
  'file_shares.host',
  'file_shares.port',
  'file_shares.share_name',
  'file_shares.root_path',
  'file_shares.case_insensitive',
  'file_shares.enabled',
] as const;

function connectionFromRow(row: {
  username: string;
  tool_access: string;
  allow_delete: boolean;
}): Result<ShareConnection, StoreError> {
  if (!isToolAccess(row.tool_access)) return err('MALFORMED_ROW' as const);
  return ok({
    username: row.username,
    toolAccess: row.tool_access,
    allowDelete: row.allow_delete === true,
  });
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
  db: Kysely<DB>,
  tenantId: string,
  subject: string
): Promise<Result<ShareWithConnection[], StoreError>> {
  const rows = await wrapAsync(
    () =>
      db
        .selectFrom('file_shares')
        .leftJoin('file_share_connections', (join) =>
          join
            .onRef('file_share_connections.tenant_id', '=', 'file_shares.tenant_id')
            .onRef('file_share_connections.share_id', '=', 'file_shares.id')
            .on('file_share_connections.subject', '=', subject)
        )
        .select([
          ...SHARE_COLUMNS,
          'file_share_connections.username',
          'file_share_connections.tool_access',
          'file_share_connections.allow_delete',
        ])
        .where('file_shares.tenant_id', '=', tenantId)
        .where('file_shares.enabled', '=', true)
        .orderBy('file_shares.name')
        .execute(),
    'DB_ERROR' as const
  );
  if (!rows.ok) return rows;

  const shares: ShareWithConnection[] = [];
  for (const row of rows.val) {
    const summary = summaryFromRow(row);
    if (!summary) return err('MALFORMED_ROW' as const);
    if (row.username === null || row.tool_access === null) {
      shares.push({ share: summary, connection: null });
      continue;
    }
    const connection = connectionFromRow({
      username: row.username,
      tool_access: row.tool_access,
      allow_delete: row.allow_delete === true,
    });
    if (!connection.ok) return connection;
    shares.push({ share: summary, connection: connection.val });
  }
  return ok(shares);
}

/** The shares this subject has connected — what the tools and browser list. */
export async function listConnectedShares(
  db: Kysely<DB>,
  tenantId: string,
  subject: string
): Promise<Result<ConnectedShare[], StoreError>> {
  const all = await listSharesWithConnection(db, tenantId, subject);
  if (!all.ok) return all;
  return ok(
    all.val.flatMap((entry) =>
      entry.connection ? [{ share: entry.share, connection: entry.connection }] : []
    )
  );
}

/** One connection's exposure row (no credential), or null if not connected. */
export async function getConnection(
  db: Kysely<DB>,
  tenantId: string,
  shareId: string,
  subject: string
): Promise<Result<ShareConnection | null, StoreError>> {
  const row = await wrapAsync(
    () =>
      db
        .selectFrom('file_share_connections')
        .select(['username', 'tool_access', 'allow_delete'])
        .where('tenant_id', '=', tenantId)
        .where('share_id', '=', shareId)
        .where('subject', '=', subject)
        .executeTakeFirst(),
    'DB_ERROR' as const
  );
  if (!row.ok) return row;
  if (!row.val) return ok(null);
  return connectionFromRow(row.val);
}

/** The sealed credential for one connection — only the worker decrypts it. */
export async function readConnectionCiphertext(
  db: Kysely<DB>,
  tenantId: string,
  shareId: string,
  subject: string
): Promise<Result<string | null, StoreError>> {
  const row = await wrapAsync(
    () =>
      db
        .selectFrom('file_share_connections')
        .select('encrypted_credentials')
        .where('tenant_id', '=', tenantId)
        .where('share_id', '=', shareId)
        .where('subject', '=', subject)
        .executeTakeFirst(),
    'DB_ERROR' as const
  );
  if (!row.ok) return row;
  return ok(row.val?.encrypted_credentials ?? null);
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
  db: Kysely<DB>,
  tenantId: string,
  shareId: string,
  subject: string,
  input: ConnectionInput
): Promise<Result<void, StoreError>> {
  const written = await wrapAsync(
    () =>
      db
        .insertInto('file_share_connections')
        .values({
          tenant_id: tenantId,
          share_id: shareId,
          subject,
          encrypted_credentials: input.encryptedCredentials,
          username: input.username,
          tool_access: input.toolAccess,
          allow_delete: input.allowDelete,
        })
        .onConflict((oc) =>
          oc.constraint('file_share_connections_pk').doUpdateSet({
            encrypted_credentials: input.encryptedCredentials,
            username: input.username,
            tool_access: input.toolAccess,
            allow_delete: input.allowDelete,
            updated_at: new Date(),
          })
        )
        .execute(),
    'DB_ERROR' as const
  );
  if (!written.ok) return written;
  return ok();
}

/** Change only the exposure choice, keeping the stored credential. */
export async function updateConnectionExposure(
  db: Kysely<DB>,
  tenantId: string,
  shareId: string,
  subject: string,
  toolAccess: ShareConnection['toolAccess'],
  allowDelete: boolean
): Promise<Result<boolean, StoreError>> {
  const updated = await wrapAsync(
    () =>
      db
        .updateTable('file_share_connections')
        .set({ tool_access: toolAccess, allow_delete: allowDelete, updated_at: new Date() })
        .where('tenant_id', '=', tenantId)
        .where('share_id', '=', shareId)
        .where('subject', '=', subject)
        .executeTakeFirst(),
    'DB_ERROR' as const
  );
  if (!updated.ok) return updated;
  return ok(updated.val.numUpdatedRows > BigInt(0));
}

/** Remove this subject's connection (credential included). */
export async function deleteConnection(
  db: Kysely<DB>,
  tenantId: string,
  shareId: string,
  subject: string
): Promise<Result<boolean, StoreError>> {
  const deleted = await wrapAsync(
    () =>
      db
        .deleteFrom('file_share_connections')
        .where('tenant_id', '=', tenantId)
        .where('share_id', '=', shareId)
        .where('subject', '=', subject)
        .executeTakeFirst(),
    'DB_ERROR' as const
  );
  if (!deleted.ok) return deleted;
  return ok(deleted.val.numDeletedRows > BigInt(0));
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
  db: Kysely<DB>,
  tenantId: string,
  subject: string
): Promise<Result<ToolExposure, StoreError>> {
  const rows = await wrapAsync(
    () =>
      db
        .selectFrom('file_share_connections')
        .innerJoin('file_shares', 'file_shares.id', 'file_share_connections.share_id')
        .select(['file_share_connections.tool_access', 'file_share_connections.allow_delete'])
        .where('file_share_connections.tenant_id', '=', tenantId)
        .where('file_share_connections.subject', '=', subject)
        .where('file_shares.enabled', '=', true)
        .execute(),
    'DB_ERROR' as const
  );
  if (!rows.ok) return rows;

  const exposure: ToolExposure = { read: false, write: false, del: false };
  for (const row of rows.val) {
    if (!isToolAccess(row.tool_access)) return err('MALFORMED_ROW' as const);
    exposure.read = true;
    const write = row.tool_access === 'read_write';
    exposure.write = exposure.write || write;
    exposure.del = exposure.del || (write && row.allow_delete === true);
  }
  return ok(exposure);
}

// ---------------------------------------------------------------------------
// Admin accessors — used only behind ROLE_OPERATOR routes.
// ---------------------------------------------------------------------------

export async function listShares(
  db: Kysely<DB>,
  tenantId: string
): Promise<Result<ShareRow[], StoreError>> {
  const rows = await wrapAsync(
    () =>
      db
        .selectFrom('file_shares')
        .selectAll()
        .where('tenant_id', '=', tenantId)
        .orderBy('name')
        .execute(),
    'DB_ERROR' as const
  );
  if (!rows.ok) return rows;

  const shares: ShareRow[] = [];
  for (const row of rows.val) {
    const summary = summaryFromRow(row);
    if (!summary) return err('MALFORMED_ROW' as const);
    shares.push({
      summary,
      settings: isRecord(row.settings) ? { ...row.settings } : {},
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at),
    });
  }
  return ok(shares);
}

export async function getShare(
  db: Kysely<DB>,
  tenantId: string,
  shareId: string
): Promise<Result<ShareRow | null, StoreError>> {
  const row = await wrapAsync(
    () =>
      db
        .selectFrom('file_shares')
        .selectAll()
        .where('tenant_id', '=', tenantId)
        .where('id', '=', shareId)
        .executeTakeFirst(),
    'DB_ERROR' as const
  );
  if (!row.ok) return row;
  if (!row.val) return ok(null);
  const summary = summaryFromRow(row.val);
  if (!summary) return err('MALFORMED_ROW' as const);
  return ok({
    summary,
    settings: isRecord(row.val.settings) ? { ...row.val.settings } : {},
    createdAt: new Date(row.val.created_at),
    updatedAt: new Date(row.val.updated_at),
  });
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
}

export async function createShare(
  db: Kysely<DB>,
  tenantId: string,
  input: ShareInput
): Promise<Result<string, StoreError | 'DUPLICATE_NAME'>> {
  const inserted = await wrapAsync(
    () =>
      db
        .insertInto('file_shares')
        .values({
          tenant_id: tenantId,
          name: input.name,
          protocol: input.protocol,
          host: input.host,
          port: input.port,
          share_name: input.shareName,
          root_path: input.rootPath,
          case_insensitive: input.caseInsensitive,
          enabled: input.enabled,
          settings: JSON.stringify({}),
        })
        .returning('id')
        .executeTakeFirstOrThrow(),
    'DB_ERROR' as const
  );
  if (!inserted.ok) {
    return isDuplicateName(inserted.err.cause) ? err('DUPLICATE_NAME' as const) : inserted;
  }
  return ok(inserted.val.id);
}

export async function updateShare(
  db: Kysely<DB>,
  tenantId: string,
  shareId: string,
  input: ShareInput
): Promise<Result<boolean, StoreError | 'DUPLICATE_NAME'>> {
  const updated = await wrapAsync(
    () =>
      db
        .updateTable('file_shares')
        .set({
          name: input.name,
          protocol: input.protocol,
          host: input.host,
          port: input.port,
          share_name: input.shareName,
          root_path: input.rootPath,
          case_insensitive: input.caseInsensitive,
          enabled: input.enabled,
          updated_at: new Date().toISOString(),
        })
        .where('tenant_id', '=', tenantId)
        .where('id', '=', shareId)
        .executeTakeFirst(),
    'DB_ERROR' as const
  );
  if (!updated.ok) {
    return isDuplicateName(updated.err.cause) ? err('DUPLICATE_NAME' as const) : updated;
  }
  return ok(updated.val.numUpdatedRows > BigInt(0));
}

export async function deleteShare(
  db: Kysely<DB>,
  tenantId: string,
  shareId: string
): Promise<Result<boolean, StoreError>> {
  const deleted = await wrapAsync(
    () =>
      db
        .deleteFrom('file_shares')
        .where('tenant_id', '=', tenantId)
        .where('id', '=', shareId)
        .executeTakeFirst(),
    'DB_ERROR' as const
  );
  if (!deleted.ok) return deleted;
  return ok(deleted.val.numDeletedRows > BigInt(0));
}

function isDuplicateName(cause: unknown): boolean {
  return (
    isRecord(cause) &&
    cause.code === '23505' &&
    typeof cause.constraint === 'string' &&
    cause.constraint === 'idx_file_shares_tenant_name'
  );
}
