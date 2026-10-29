/**
 * Code project services — the `sandbox_services` row (migration 122) that
 * describes a container this worker created on its Docker engine
 * (services.ts), through the data store (`sandboxServices`). Every read and
 * write is scoped by subject, the same no-cross-caller discipline as
 * sandbox_workspaces; the sweep's walks are the ones that are not.
 * Lifetimes are decided here.
 */

import { randomUUID } from 'node:crypto';
import { getDataStore, type SandboxServiceRecord } from '@renkei/db';
import {
  SERVICE_TTL_MS,
  type SandboxServiceSummary,
  type ServiceStatus,
} from '@renkei/connector-sandbox';

export interface ServiceTarget {
  subject: string;
}

export interface StoredService extends SandboxServiceSummary, ServiceTarget {
  containerId: string | null;
  exports: Record<string, string>;
}

function statusOf(value: string): ServiceStatus {
  return value === 'running' || value === 'stopped' || value === 'failed' || value === 'gone'
    ? value
    : 'starting';
}

function toStored(record: SandboxServiceRecord): StoredService {
  return {
    id: record.id,
    subject: record.subject,
    name: record.name,
    image: record.image,
    containerId: record.containerId,
    status: statusOf(record.status),
    error: record.error,
    host: record.host,
    ports: record.ports,
    exports: record.exports,
    exportNames: Object.keys(record.exports).sort(),
    createdAt: record.createdAt,
    lastUsedAt: record.lastUsedAt,
    expiresAt: record.expiresAt,
  };
}

const services = () => getDataStore().sandboxServices;

export function expiryFromNow(): Date {
  return new Date(Date.now() + SERVICE_TTL_MS);
}

export async function insertService(
  input: ServiceTarget & { name: string; image: string; exports: Record<string, string> }
): Promise<StoredService> {
  const record = await services().insert({
    id: randomUUID(),
    subject: input.subject,
    name: input.name,
    image: input.image,
    exports: input.exports,
    expiresAt: expiryFromNow(),
  });
  return toStored(record);
}

export async function listServices(target: ServiceTarget): Promise<StoredService[]> {
  return (await services().list(target.subject)).map(toStored);
}

export async function getServiceByName(
  target: ServiceTarget,
  name: string
): Promise<StoredService | undefined> {
  const record = await services().getByName(target.subject, name);
  return record ? toStored(record) : undefined;
}

export async function updateService(
  id: string,
  input: {
    status?: ServiceStatus;
    error?: string | null;
    containerId?: string | null;
    host?: string | null;
    ports?: number[];
  }
): Promise<void> {
  await services().update(id, input);
}

/** Any use extends the lifetime: a service the project's commands are talking to is not stale. */
export async function touchServices(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  await services().touch(ids, { lastUsedAt: new Date(), expiresAt: expiryFromNow() });
}

export async function deleteServiceById(id: string): Promise<void> {
  await services().deleteById(id);
}

/** Rows past their expiry — the sweep stops and removes each one's container, then the row. */
export async function listExpiredServices(limit: number): Promise<StoredService[]> {
  return (await services().listExpired(new Date(), limit)).map(toStored);
}

/** Every container id a row still claims — for the sweep to tell an orphaned container from a claimed one. */
export async function listClaimedContainerIds(): Promise<Set<string>> {
  return new Set(await services().listClaimedContainerIds());
}
