/**
 * Kysely accessors for Mirth instances and per-user connections — the only
 * file that knows the table shapes. Everything returns Result and every
 * uncertain outcome denies: a DB error is an error (not "no instances"),
 * and a row that fails validation poisons the read rather than being
 * skipped.
 *
 * There is no authorization model here. Operators register an instance's
 * connection details; each person stores their OWN Mirth credential for it
 * (the connection row), and the Mirth server is the sole authority on what
 * that account may do. What a connection row does carry besides the sealed
 * credential is the person's LLM-exposure choice, which the tool layer
 * reads and the worker's request path deliberately does not.
 */

import type { Kysely } from 'kysely';
import type { DB } from '@renkei/db';
import { ok, err, wrapAsync } from '@campfhir/safe-functions/helpers';
import type { Result } from '@campfhir/safe-functions/types';
import { normalizePermissions, type MirthPermission } from './permissions';
import type { InstanceConnection, MirthInstanceSummary } from './types';

export type StoreError = 'DB_ERROR' | 'MALFORMED_ROW';

export interface InstanceRow {
  summary: MirthInstanceSummary;
  /** The pinned CA certificate (PEM), when one is registered. */
  caPem: string | null;
  settings: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

interface RawInstance {
  id: string;
  name: string;
  environment: string;
  base_url: string;
  tls_verify: boolean;
  ca_pem: string | null;
  allow_insecure_http: boolean;
  enabled: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function summaryFromRow(row: RawInstance): MirthInstanceSummary {
  return {
    id: row.id,
    name: row.name,
    environment: row.environment,
    baseUrl: row.base_url,
    tlsVerify: row.tls_verify,
    hasCustomCa: typeof row.ca_pem === 'string' && row.ca_pem.trim().length > 0,
    allowInsecureHttp: row.allow_insecure_http,
    enabled: row.enabled,
  };
}

const INSTANCE_COLUMNS = [
  'mirth_instances.id',
  'mirth_instances.name',
  'mirth_instances.environment',
  'mirth_instances.base_url',
  'mirth_instances.tls_verify',
  'mirth_instances.ca_pem',
  'mirth_instances.allow_insecure_http',
  'mirth_instances.enabled',
] as const;

function connectionFromRow(row: {
  username: string;
  permissions: unknown;
}): Result<InstanceConnection, StoreError> {
  if (!Array.isArray(row.permissions)) return err('MALFORMED_ROW' as const);
  // Unknown ids (a permission removed from the catalog) are dropped rather
  // than poisoning the row: less access, never more.
  return ok({ username: row.username, permissions: normalizePermissions(row.permissions) });
}

// ---------------------------------------------------------------------------
// Per-user connections — the caller's own credential + exposure choice.
// ---------------------------------------------------------------------------

export interface ConnectedInstance {
  instance: MirthInstanceSummary;
  connection: InstanceConnection;
}

/** Every enabled instance, with this subject's connection where one exists. */
export interface InstanceWithConnection {
  instance: MirthInstanceSummary;
  connection: InstanceConnection | null;
}

/**
 * The connectors-page view: all enabled instances an operator has
 * registered, marked with whether THIS person has connected each. Listing
 * an instance's existence to everyone is deliberate — discovery is not a
 * secret in this model, credentials are the gate.
 */
export async function listInstancesWithConnection(
  db: Kysely<DB>,
  tenantId: string,
  subject: string
): Promise<Result<InstanceWithConnection[], StoreError>> {
  const rows = await wrapAsync(
    () =>
      db
        .selectFrom('mirth_instances')
        .leftJoin('mirth_instance_connections', (join) =>
          join
            .onRef('mirth_instance_connections.tenant_id', '=', 'mirth_instances.tenant_id')
            .onRef('mirth_instance_connections.instance_id', '=', 'mirth_instances.id')
            .on('mirth_instance_connections.subject', '=', subject)
        )
        .select([
          ...INSTANCE_COLUMNS,
          'mirth_instance_connections.username',
          'mirth_instance_connections.permissions',
        ])
        .where('mirth_instances.tenant_id', '=', tenantId)
        .where('mirth_instances.enabled', '=', true)
        .orderBy('mirth_instances.name')
        .execute(),
    'DB_ERROR' as const
  );
  if (!rows.ok) return rows;

  const instances: InstanceWithConnection[] = [];
  for (const row of rows.val) {
    const summary = summaryFromRow(row);
    if (row.username === null || row.permissions === null) {
      instances.push({ instance: summary, connection: null });
      continue;
    }
    const connection = connectionFromRow({ username: row.username, permissions: row.permissions });
    if (!connection.ok) return connection;
    instances.push({ instance: summary, connection: connection.val });
  }
  return ok(instances);
}

/** The instances this subject has connected — what the tools list. */
export async function listConnectedInstances(
  db: Kysely<DB>,
  tenantId: string,
  subject: string
): Promise<Result<ConnectedInstance[], StoreError>> {
  const all = await listInstancesWithConnection(db, tenantId, subject);
  if (!all.ok) return all;
  return ok(
    all.val.flatMap((entry) =>
      entry.connection ? [{ instance: entry.instance, connection: entry.connection }] : []
    )
  );
}

/** One connection's exposure row (no credential), or null if not connected. */
export async function getConnection(
  db: Kysely<DB>,
  tenantId: string,
  instanceId: string,
  subject: string
): Promise<Result<InstanceConnection | null, StoreError>> {
  const row = await wrapAsync(
    () =>
      db
        .selectFrom('mirth_instance_connections')
        .select(['username', 'permissions'])
        .where('tenant_id', '=', tenantId)
        .where('instance_id', '=', instanceId)
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
  instanceId: string,
  subject: string
): Promise<Result<string | null, StoreError>> {
  const row = await wrapAsync(
    () =>
      db
        .selectFrom('mirth_instance_connections')
        .select('encrypted_credentials')
        .where('tenant_id', '=', tenantId)
        .where('instance_id', '=', instanceId)
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
  permissions: readonly MirthPermission[];
}

/** Store or replace this subject's connection to an instance. */
export async function upsertConnection(
  db: Kysely<DB>,
  tenantId: string,
  instanceId: string,
  subject: string,
  input: ConnectionInput
): Promise<Result<void, StoreError>> {
  const written = await wrapAsync(
    () =>
      db
        .insertInto('mirth_instance_connections')
        .values({
          tenant_id: tenantId,
          instance_id: instanceId,
          subject,
          encrypted_credentials: input.encryptedCredentials,
          username: input.username,
          permissions: [...input.permissions],
        })
        .onConflict((oc) =>
          oc.constraint('mirth_instance_connections_pk').doUpdateSet({
            encrypted_credentials: input.encryptedCredentials,
            username: input.username,
            permissions: [...input.permissions],
            updated_at: new Date(),
          })
        )
        .execute(),
    'DB_ERROR' as const
  );
  if (!written.ok) return written;
  return ok();
}

/** Change only the permissions, keeping the stored credential. */
export async function updateConnectionPermissions(
  db: Kysely<DB>,
  tenantId: string,
  instanceId: string,
  subject: string,
  permissions: readonly MirthPermission[]
): Promise<Result<boolean, StoreError>> {
  const updated = await wrapAsync(
    () =>
      db
        .updateTable('mirth_instance_connections')
        .set({ permissions: [...permissions], updated_at: new Date() })
        .where('tenant_id', '=', tenantId)
        .where('instance_id', '=', instanceId)
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
  instanceId: string,
  subject: string
): Promise<Result<boolean, StoreError>> {
  const deleted = await wrapAsync(
    () =>
      db
        .deleteFrom('mirth_instance_connections')
        .where('tenant_id', '=', tenantId)
        .where('instance_id', '=', instanceId)
        .where('subject', '=', subject)
        .executeTakeFirst(),
    'DB_ERROR' as const
  );
  if (!deleted.ok) return deleted;
  return ok(deleted.val.numDeletedRows > BigInt(0));
}

/** The permissions this subject holds across every enabled instance — see registry. */
export interface ToolExposure {
  /** Any connection at all: the instance list and the lookups register. */
  connected: boolean;
  /** The union of the permissions granted on any connected, enabled instance. */
  permissions: MirthPermission[];
}

/**
 * The availability question the MCP transport asks per connection setup:
 * which Mirth tools should register for this subject? A tool registers
 * when SOME connected instance grants its permission; the per-instance
 * check happens again on every call.
 */
export async function resolveToolExposure(
  db: Kysely<DB>,
  tenantId: string,
  subject: string
): Promise<Result<ToolExposure, StoreError>> {
  const rows = await wrapAsync(
    () =>
      db
        .selectFrom('mirth_instance_connections')
        .innerJoin(
          'mirth_instances',
          'mirth_instances.id',
          'mirth_instance_connections.instance_id'
        )
        .select(['mirth_instance_connections.permissions'])
        .where('mirth_instance_connections.tenant_id', '=', tenantId)
        .where('mirth_instance_connections.subject', '=', subject)
        .where('mirth_instances.enabled', '=', true)
        .execute(),
    'DB_ERROR' as const
  );
  if (!rows.ok) return rows;

  const granted: unknown[] = [];
  for (const row of rows.val) {
    if (!Array.isArray(row.permissions)) return err('MALFORMED_ROW' as const);
    granted.push(...row.permissions);
  }
  return ok({ connected: rows.val.length > 0, permissions: normalizePermissions(granted) });
}

// ---------------------------------------------------------------------------
// Admin accessors — used only behind ROLE_OPERATOR routes.
// ---------------------------------------------------------------------------

function rowFromRaw(
  row: RawInstance & { settings: unknown; created_at: Date; updated_at: Date }
): InstanceRow {
  return {
    summary: summaryFromRow(row),
    caPem: typeof row.ca_pem === 'string' && row.ca_pem.trim() ? row.ca_pem : null,
    settings: isRecord(row.settings) ? { ...row.settings } : {},
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  };
}

export async function listInstances(
  db: Kysely<DB>,
  tenantId: string
): Promise<Result<InstanceRow[], StoreError>> {
  const rows = await wrapAsync(
    () =>
      db
        .selectFrom('mirth_instances')
        .selectAll()
        .where('tenant_id', '=', tenantId)
        .orderBy('name')
        .execute(),
    'DB_ERROR' as const
  );
  if (!rows.ok) return rows;
  return ok(rows.val.map((row) => rowFromRaw(row)));
}

export async function getInstance(
  db: Kysely<DB>,
  tenantId: string,
  instanceId: string
): Promise<Result<InstanceRow | null, StoreError>> {
  const row = await wrapAsync(
    () =>
      db
        .selectFrom('mirth_instances')
        .selectAll()
        .where('tenant_id', '=', tenantId)
        .where('id', '=', instanceId)
        .executeTakeFirst(),
    'DB_ERROR' as const
  );
  if (!row.ok) return row;
  if (!row.val) return ok(null);
  return ok(rowFromRaw(row.val));
}

export interface InstanceInput {
  name: string;
  environment: string;
  baseUrl: string;
  tlsVerify: boolean;
  /** Null clears a pinned CA; undefined keeps whatever is stored. */
  caPem: string | null | undefined;
  allowInsecureHttp: boolean;
  enabled: boolean;
}

export async function createInstance(
  db: Kysely<DB>,
  tenantId: string,
  input: InstanceInput
): Promise<Result<string, StoreError | 'DUPLICATE_NAME'>> {
  const inserted = await wrapAsync(
    () =>
      db
        .insertInto('mirth_instances')
        .values({
          tenant_id: tenantId,
          name: input.name,
          environment: input.environment,
          base_url: input.baseUrl,
          tls_verify: input.tlsVerify,
          ca_pem: input.caPem ?? null,
          allow_insecure_http: input.allowInsecureHttp,
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

export async function updateInstance(
  db: Kysely<DB>,
  tenantId: string,
  instanceId: string,
  input: InstanceInput
): Promise<Result<boolean, StoreError | 'DUPLICATE_NAME'>> {
  const updated = await wrapAsync(
    () =>
      db
        .updateTable('mirth_instances')
        .set({
          name: input.name,
          environment: input.environment,
          base_url: input.baseUrl,
          tls_verify: input.tlsVerify,
          ...(input.caPem === undefined ? {} : { ca_pem: input.caPem }),
          allow_insecure_http: input.allowInsecureHttp,
          enabled: input.enabled,
          updated_at: new Date().toISOString(),
        })
        .where('tenant_id', '=', tenantId)
        .where('id', '=', instanceId)
        .executeTakeFirst(),
    'DB_ERROR' as const
  );
  if (!updated.ok) {
    return isDuplicateName(updated.err.cause) ? err('DUPLICATE_NAME' as const) : updated;
  }
  return ok(updated.val.numUpdatedRows > BigInt(0));
}

export async function deleteInstance(
  db: Kysely<DB>,
  tenantId: string,
  instanceId: string
): Promise<Result<boolean, StoreError>> {
  const deleted = await wrapAsync(
    () =>
      db
        .deleteFrom('mirth_instances')
        .where('tenant_id', '=', tenantId)
        .where('id', '=', instanceId)
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
    cause.constraint === 'idx_mirth_instances_tenant_name'
  );
}
