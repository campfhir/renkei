/**
 * Kysely accessors for ADManager Plus instances and per-user connections —
 * the only file that knows the table shapes. Everything returns Result and
 * every uncertain outcome denies: a DB error is an error (not "no
 * instances"), and a row that fails validation poisons the read rather
 * than being skipped.
 *
 * There is no authorization model here. Operators register an instance's
 * connection details; each person stores their OWN ADManager Plus
 * authtoken for it (the connection row), and ADManager Plus's own
 * authtoken scope plus the technician's delegated rights are the sole
 * authority on what that account may do. What a connection row does carry
 * besides the sealed credential is the person's LLM-exposure choice,
 * which the tool layer reads and the worker's request path deliberately
 * does not.
 */

import { sql, type Kysely } from 'kysely';
import type { DB } from '@renkei/db';
import { ok, err, wrapAsync } from '@campfhir/safe-functions/helpers';
import type { Result } from '@campfhir/safe-functions/types';
import { normalizePermissions, type AdManagerPermission } from './permissions';
import { readInstanceSettings } from './types';
import type { InstanceConnection, AdManagerInstanceSummary } from './types';

export type StoreError = 'DB_ERROR' | 'MALFORMED_ROW';

export interface InstanceRow {
  summary: AdManagerInstanceSummary;
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
  settings: unknown;
  enabled: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function summaryFromRow(row: RawInstance): AdManagerInstanceSummary {
  return {
    id: row.id,
    name: row.name,
    environment: row.environment,
    baseUrl: row.base_url,
    tlsVerify: row.tls_verify,
    hasCustomCa: typeof row.ca_pem === 'string' && row.ca_pem.trim().length > 0,
    allowInsecureHttp: row.allow_insecure_http,
    resetPasswordTemplateName: readInstanceSettings(row.settings).resetPasswordTemplateName,
    enabled: row.enabled,
  };
}

const INSTANCE_COLUMNS = [
  'admanager_instances.id',
  'admanager_instances.name',
  'admanager_instances.environment',
  'admanager_instances.base_url',
  'admanager_instances.tls_verify',
  'admanager_instances.ca_pem',
  'admanager_instances.allow_insecure_http',
  'admanager_instances.settings',
  'admanager_instances.enabled',
] as const;

function connectionFromRow(row: {
  technician_name: string;
  permissions: unknown;
}): Result<InstanceConnection, StoreError> {
  if (!Array.isArray(row.permissions)) return err('MALFORMED_ROW' as const);
  // Unknown ids (a permission removed from the catalog) are dropped rather
  // than poisoning the row: less access, never more.
  return ok({
    technicianName: row.technician_name,
    permissions: normalizePermissions(row.permissions),
  });
}

// ---------------------------------------------------------------------------
// Per-user connections — the caller's own credential + exposure choice.
// ---------------------------------------------------------------------------

export interface ConnectedInstance {
  instance: AdManagerInstanceSummary;
  connection: InstanceConnection;
}

/** Every enabled instance, with this subject's connection where one exists. */
export interface InstanceWithConnection {
  instance: AdManagerInstanceSummary;
  connection: InstanceConnection | null;
}

/**
 * The connectors-page view: all enabled instances an operator has
 * registered, marked with whether THIS person has connected each.
 * Listing an instance's existence to everyone is deliberate — discovery
 * is not a secret in this model, credentials are the gate.
 */
export async function listInstancesWithConnection(
  db: Kysely<DB>,
  tenantId: string,
  subject: string
): Promise<Result<InstanceWithConnection[], StoreError>> {
  const rows = await wrapAsync(
    () =>
      db
        .selectFrom('admanager_instances')
        .leftJoin('admanager_instance_connections', (join) =>
          join
            .onRef(
              'admanager_instance_connections.tenant_id',
              '=',
              'admanager_instances.tenant_id'
            )
            .onRef('admanager_instance_connections.instance_id', '=', 'admanager_instances.id')
            .on('admanager_instance_connections.subject', '=', subject)
        )
        .select([
          ...INSTANCE_COLUMNS,
          'admanager_instance_connections.technician_name',
          'admanager_instance_connections.permissions',
        ])
        .where('admanager_instances.tenant_id', '=', tenantId)
        .where('admanager_instances.enabled', '=', true)
        .orderBy('admanager_instances.name')
        .execute(),
    'DB_ERROR' as const
  );
  if (!rows.ok) return rows;

  const instances: InstanceWithConnection[] = [];
  for (const row of rows.val) {
    const summary = summaryFromRow(row);
    if (row.technician_name === null || row.permissions === null) {
      instances.push({ instance: summary, connection: null });
      continue;
    }
    const connection = connectionFromRow({
      technician_name: row.technician_name,
      permissions: row.permissions,
    });
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
        .selectFrom('admanager_instance_connections')
        .select(['technician_name', 'permissions'])
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
        .selectFrom('admanager_instance_connections')
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
  /** The technician name, for display on the connectors card. */
  technicianName: string;
  permissions: readonly AdManagerPermission[];
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
        .insertInto('admanager_instance_connections')
        .values({
          tenant_id: tenantId,
          instance_id: instanceId,
          subject,
          encrypted_credentials: input.encryptedCredentials,
          technician_name: input.technicianName,
          permissions: [...input.permissions],
        })
        .onConflict((oc) =>
          oc.constraint('admanager_instance_connections_pk').doUpdateSet({
            encrypted_credentials: input.encryptedCredentials,
            technician_name: input.technicianName,
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
  permissions: readonly AdManagerPermission[]
): Promise<Result<boolean, StoreError>> {
  const updated = await wrapAsync(
    () =>
      db
        .updateTable('admanager_instance_connections')
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
        .deleteFrom('admanager_instance_connections')
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
  permissions: AdManagerPermission[];
}

/**
 * The availability question the MCP transport asks per connection setup:
 * which ADManager Plus tools should register for this subject? A tool
 * registers when SOME connected instance grants its permission; the
 * per-instance check happens again on every call.
 */
export async function resolveToolExposure(
  db: Kysely<DB>,
  tenantId: string,
  subject: string
): Promise<Result<ToolExposure, StoreError>> {
  const rows = await wrapAsync(
    () =>
      db
        .selectFrom('admanager_instance_connections')
        .innerJoin(
          'admanager_instances',
          'admanager_instances.id',
          'admanager_instance_connections.instance_id'
        )
        .select(['admanager_instance_connections.permissions'])
        .where('admanager_instance_connections.tenant_id', '=', tenantId)
        .where('admanager_instance_connections.subject', '=', subject)
        .where('admanager_instances.enabled', '=', true)
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

function rowFromRaw(row: RawInstance & { created_at: Date; updated_at: Date }): InstanceRow {
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
        .selectFrom('admanager_instances')
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
        .selectFrom('admanager_instances')
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
  /** Null records "no template" — the reset tool then cannot force a change at next logon. */
  resetPasswordTemplateName: string | null;
  enabled: boolean;
}

/**
 * The `settings` keys this input owns. Written as a whole object on
 * create; merged over the stored JSON on update (a key set to null is
 * removed rather than stored as null) so any setting a later migration
 * adds under the same column survives an edit from an older form.
 */
const SETTINGS_KEYS = ['resetPasswordTemplateName'] as const;

function settingsFromInput(input: InstanceInput): Record<string, string> {
  return input.resetPasswordTemplateName === null
    ? {}
    : { resetPasswordTemplateName: input.resetPasswordTemplateName };
}

export async function createInstance(
  db: Kysely<DB>,
  tenantId: string,
  input: InstanceInput
): Promise<Result<string, StoreError | 'DUPLICATE_NAME'>> {
  const inserted = await wrapAsync(
    () =>
      db
        .insertInto('admanager_instances')
        .values({
          tenant_id: tenantId,
          name: input.name,
          environment: input.environment,
          base_url: input.baseUrl,
          tls_verify: input.tlsVerify,
          ca_pem: input.caPem ?? null,
          allow_insecure_http: input.allowInsecureHttp,
          enabled: input.enabled,
          settings: JSON.stringify(settingsFromInput(input)),
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
        .updateTable('admanager_instances')
        .set({
          name: input.name,
          environment: input.environment,
          base_url: input.baseUrl,
          tls_verify: input.tlsVerify,
          ...(input.caPem === undefined ? {} : { ca_pem: input.caPem }),
          allow_insecure_http: input.allowInsecureHttp,
          // jsonb - text[] drops the keys this form owns, then || lays the
          // new values over what remains.
          settings: sql`(settings - ARRAY[${sql.join(SETTINGS_KEYS.map((key) => sql.lit(key)))}]::text[]) || ${JSON.stringify(settingsFromInput(input))}::jsonb`,
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
        .deleteFrom('admanager_instances')
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
    cause.constraint === 'idx_admanager_instances_tenant_name'
  );
}
