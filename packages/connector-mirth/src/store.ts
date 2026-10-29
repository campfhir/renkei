/**
 * Mirth instances and per-user connections, through the data store
 * (`getDataStore().mirthInstances`): the store keeps and returns rows, this file
 * validates them into the connector's types. Everything returns Result and
 * every uncertain outcome denies: a storage error is an error (not "no
 * instances"), and a row that fails validation poisons the read rather
 * than being skipped.
 *
 * There is no authorization model here. Operators register an instance's
 * connection details; each person stores their OWN Mirth credential for it
 * (the connection row), and the Mirth server is the sole authority on what
 * that account may do. What a connection row does carry besides the sealed
 * credential is the person's LLM-exposure choice, which the tool layer
 * reads and the worker's request path deliberately does not.
 */

import { getDataStore, type MirthInstanceRecord } from '@renkei/db';
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function summaryFromRecord(row: MirthInstanceRecord): MirthInstanceSummary {
  return {
    id: row.id,
    name: row.name,
    environment: row.environment,
    baseUrl: row.baseUrl,
    tlsVerify: row.tlsVerify,
    hasCustomCa: typeof row.caPem === 'string' && row.caPem.trim().length > 0,
    allowInsecureHttp: row.allowInsecureHttp,
    enabled: row.enabled,
  };
}

function connectionFromRecord(row: {
  username: string;
  permissions: unknown;
}): Result<InstanceConnection, StoreError> {
  if (!Array.isArray(row.permissions)) return err('MALFORMED_ROW' as const);
  // Unknown ids (a permission removed from the catalog) are dropped rather
  // than poisoning the row: less access, never more.
  return ok({ username: row.username, permissions: normalizePermissions(row.permissions) });
}

function rowFromRecord(row: MirthInstanceRecord): InstanceRow {
  return {
    summary: summaryFromRecord(row),
    caPem: typeof row.caPem === 'string' && row.caPem.trim() ? row.caPem : null,
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
  subject: string
): Promise<Result<InstanceWithConnection[], StoreError>> {
  const rows = await wrapAsync(
    () => getDataStore().mirthInstances.listWithConnection(subject),
    'DB_ERROR' as const
  );
  if (!rows.ok) return rows;

  const instances: InstanceWithConnection[] = [];
  for (const row of rows.val) {
    const summary = summaryFromRecord(row.instance);
    if (!row.connection) {
      instances.push({ instance: summary, connection: null });
      continue;
    }
    const connection = connectionFromRecord(row.connection);
    if (!connection.ok) return connection;
    instances.push({ instance: summary, connection: connection.val });
  }
  return ok(instances);
}

/** The instances this subject has connected — what the tools list. */
export async function listConnectedInstances(
  subject: string
): Promise<Result<ConnectedInstance[], StoreError>> {
  const all = await listInstancesWithConnection(subject);
  if (!all.ok) return all;
  return ok(
    all.val.flatMap((entry) =>
      entry.connection ? [{ instance: entry.instance, connection: entry.connection }] : []
    )
  );
}

/** One connection's exposure row (no credential), or null if not connected. */
export async function getConnection(
  instanceId: string,
  subject: string
): Promise<Result<InstanceConnection | null, StoreError>> {
  const row = await wrapAsync(
    () => getDataStore().mirthInstances.getConnection(instanceId, subject),
    'DB_ERROR' as const
  );
  if (!row.ok) return row;
  if (!row.val) return ok(null);
  return connectionFromRecord(row.val);
}

/** The sealed credential for one connection — only the worker decrypts it. */
export async function readConnectionCiphertext(
  instanceId: string,
  subject: string
): Promise<Result<string | null, StoreError>> {
  const row = await wrapAsync(
    () => getDataStore().mirthInstances.getConnection(instanceId, subject),
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
  permissions: readonly MirthPermission[];
}

/** Store or replace this subject's connection to an instance. */
export async function upsertConnection(
  instanceId: string,
  subject: string,
  input: ConnectionInput
): Promise<Result<void, StoreError>> {
  const written = await wrapAsync(
    () =>
      getDataStore().mirthInstances.upsertConnection(instanceId, subject, {
        encryptedCredentials: input.encryptedCredentials,
        username: input.username,
        permissions: [...input.permissions],
      }),
    'DB_ERROR' as const
  );
  if (!written.ok) return written;
  return ok();
}

/** Change only the permissions, keeping the stored credential. */
export async function updateConnectionPermissions(
  instanceId: string,
  subject: string,
  permissions: readonly MirthPermission[]
): Promise<Result<boolean, StoreError>> {
  const updated = await wrapAsync(
    () =>
      getDataStore().mirthInstances.updateConnectionPermissions(instanceId, subject, [
        ...permissions,
      ]),
    'DB_ERROR' as const
  );
  if (!updated.ok) return updated;
  return ok(updated.val > 0);
}

/** Remove this subject's connection (credential included). */
export async function deleteConnection(
  instanceId: string,
  subject: string
): Promise<Result<boolean, StoreError>> {
  const deleted = await wrapAsync(
    () => getDataStore().mirthInstances.deleteConnection(instanceId, subject),
    'DB_ERROR' as const
  );
  if (!deleted.ok) return deleted;
  return ok(deleted.val > 0);
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
  subject: string
): Promise<Result<ToolExposure, StoreError>> {
  const rows = await wrapAsync(
    () => getDataStore().mirthInstances.connectionPermissions(subject),
    'DB_ERROR' as const
  );
  if (!rows.ok) return rows;

  const granted: unknown[] = [];
  for (const permissions of rows.val) {
    if (!Array.isArray(permissions)) return err('MALFORMED_ROW' as const);
    granted.push(...permissions);
  }
  return ok({ connected: rows.val.length > 0, permissions: normalizePermissions(granted) });
}

// ---------------------------------------------------------------------------
// Admin accessors — used only behind ROLE_OPERATOR routes.
// ---------------------------------------------------------------------------

export async function listInstances(): Promise<Result<InstanceRow[], StoreError>> {
  const rows = await wrapAsync(() => getDataStore().mirthInstances.list(), 'DB_ERROR' as const);
  if (!rows.ok) return rows;
  return ok(rows.val.map(rowFromRecord));
}

export async function getInstance(
  instanceId: string
): Promise<Result<InstanceRow | null, StoreError>> {
  const row = await wrapAsync(
    () => getDataStore().mirthInstances.get(instanceId),
    'DB_ERROR' as const
  );
  if (!row.ok) return row;
  return ok(row.val ? rowFromRecord(row.val) : null);
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
  input: InstanceInput
): Promise<Result<string, StoreError | 'DUPLICATE_NAME'>> {
  const inserted = await wrapAsync(
    () => getDataStore().mirthInstances.create(input),
    'DB_ERROR' as const
  );
  if (!inserted.ok) {
    return isDuplicateName(inserted.err.cause) ? err('DUPLICATE_NAME' as const) : inserted;
  }
  return ok(inserted.val);
}

export async function updateInstance(
  instanceId: string,
  input: InstanceInput
): Promise<Result<boolean, StoreError | 'DUPLICATE_NAME'>> {
  const updated = await wrapAsync(
    () => getDataStore().mirthInstances.update(instanceId, input),
    'DB_ERROR' as const
  );
  if (!updated.ok) {
    return isDuplicateName(updated.err.cause) ? err('DUPLICATE_NAME' as const) : updated;
  }
  return ok(updated.val > 0);
}

export async function deleteInstance(instanceId: string): Promise<Result<boolean, StoreError>> {
  const deleted = await wrapAsync(
    () => getDataStore().mirthInstances.delete(instanceId),
    'DB_ERROR' as const
  );
  if (!deleted.ok) return deleted;
  return ok(deleted.val > 0);
}
