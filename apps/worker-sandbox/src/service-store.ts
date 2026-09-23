/**
 * Postgres access for code project services — the `sandbox_services` row
 * (migration 122) that describes a container this worker created on its
 * Docker engine (services.ts). Every read and write is scoped by
 * (tenantId, subject), the same no-cross-caller discipline as
 * sandbox_workspaces; the sweep's expiry walk is the one query that is
 * not.
 */

import { randomUUID } from 'node:crypto';
import type { Kysely } from 'kysely';
import type { DB } from '@renkei/db';
import {
  SERVICE_TTL_MS,
  type SandboxServiceSummary,
  type ServiceStatus,
} from '@renkei/connector-sandbox';

export interface ServiceTarget {
  tenantId: string;
  subject: string;
}

export interface StoredService extends SandboxServiceSummary, ServiceTarget {
  containerId: string | null;
  exports: Record<string, string>;
}

const COLUMNS = [
  'id',
  'tenant_id',
  'subject',
  'name',
  'image',
  'container_id',
  'status',
  'error',
  'host',
  'ports',
  'exports',
  'created_at',
  'last_used_at',
  'expires_at',
] as const;

function statusOf(value: string): ServiceStatus {
  return value === 'running' || value === 'stopped' || value === 'failed' || value === 'gone'
    ? value
    : 'starting';
}

function portsOf(value: unknown): number[] {
  return Array.isArray(value)
    ? value.filter((port): port is number => typeof port === 'number' && Number.isInteger(port))
    : [];
}

function exportsOf(value: unknown): Record<string, string> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  const out: Record<string, string> = {};
  for (const [name, template] of Object.entries(value)) {
    if (typeof template === 'string') out[name] = template;
  }
  return out;
}

function toStored(row: {
  id: string;
  tenant_id: string;
  subject: string;
  name: string;
  image: string;
  container_id: string | null;
  status: string;
  error: string | null;
  host: string | null;
  ports: unknown;
  exports: unknown;
  created_at: Date;
  last_used_at: Date;
  expires_at: Date;
}): StoredService {
  const exports = exportsOf(row.exports);
  return {
    id: row.id,
    tenantId: row.tenant_id,
    subject: row.subject,
    name: row.name,
    image: row.image,
    containerId: row.container_id,
    status: statusOf(row.status),
    error: row.error,
    host: row.host,
    ports: portsOf(row.ports),
    exports,
    exportNames: Object.keys(exports).sort(),
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
    expiresAt: row.expires_at,
  };
}

export function expiryFromNow(): Date {
  return new Date(Date.now() + SERVICE_TTL_MS);
}

export async function insertService(
  db: Kysely<DB>,
  input: ServiceTarget & { name: string; image: string; exports: Record<string, string> }
): Promise<StoredService> {
  const row = await db
    .insertInto('sandbox_services')
    .values({
      id: randomUUID(),
      tenant_id: input.tenantId,
      subject: input.subject,
      name: input.name,
      image: input.image,
      status: 'starting',
      exports: JSON.stringify(input.exports),
      expires_at: expiryFromNow(),
    })
    .returning(COLUMNS)
    .executeTakeFirstOrThrow();
  return toStored(row);
}

export async function listServices(
  db: Kysely<DB>,
  target: ServiceTarget
): Promise<StoredService[]> {
  const rows = await db
    .selectFrom('sandbox_services')
    .select(COLUMNS)
    .where('tenant_id', '=', target.tenantId)
    .where('subject', '=', target.subject)
    .orderBy('name')
    .execute();
  return rows.map(toStored);
}

export async function getServiceByName(
  db: Kysely<DB>,
  target: ServiceTarget,
  name: string
): Promise<StoredService | undefined> {
  const row = await db
    .selectFrom('sandbox_services')
    .select(COLUMNS)
    .where('tenant_id', '=', target.tenantId)
    .where('subject', '=', target.subject)
    .where('name', '=', name)
    .executeTakeFirst();
  return row ? toStored(row) : undefined;
}

export async function updateService(
  db: Kysely<DB>,
  id: string,
  input: {
    status?: ServiceStatus;
    error?: string | null;
    containerId?: string | null;
    host?: string | null;
    ports?: number[];
  }
): Promise<void> {
  await db
    .updateTable('sandbox_services')
    .set({
      ...(input.status !== undefined ? { status: input.status } : {}),
      ...(input.error !== undefined ? { error: input.error } : {}),
      ...(input.containerId !== undefined ? { container_id: input.containerId } : {}),
      ...(input.host !== undefined ? { host: input.host } : {}),
      ...(input.ports !== undefined ? { ports: JSON.stringify(input.ports) } : {}),
    })
    .where('id', '=', id)
    .execute();
}

/** Any use extends the lifetime: a service the project's commands are talking to is not stale. */
export async function touchServices(db: Kysely<DB>, ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  await db
    .updateTable('sandbox_services')
    .set({ last_used_at: new Date(), expires_at: expiryFromNow() })
    .where('id', 'in', ids)
    .execute();
}

export async function deleteServiceById(db: Kysely<DB>, id: string): Promise<void> {
  await db.deleteFrom('sandbox_services').where('id', '=', id).execute();
}

/** Rows past their expiry — the sweep stops and removes each one's container, then the row. */
export async function listExpiredServices(db: Kysely<DB>, limit: number): Promise<StoredService[]> {
  const rows = await db
    .selectFrom('sandbox_services')
    .select(COLUMNS)
    .where('expires_at', '<', new Date())
    .limit(limit)
    .execute();
  return rows.map(toStored);
}

/** Every container id a row still claims — for the sweep to tell an orphaned container from a claimed one. */
export async function listClaimedContainerIds(db: Kysely<DB>): Promise<Set<string>> {
  const rows = await db
    .selectFrom('sandbox_services')
    .select('container_id')
    .where('container_id', 'is not', null)
    .execute();
  return new Set(
    rows.map((row) => row.container_id).filter((id): id is string => typeof id === 'string')
  );
}
