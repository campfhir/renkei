import type { Selectable } from 'kysely';
import type { SandboxServices } from '../../../db.types';
import type { SandboxServiceRecord, SandboxServiceStore } from './types';

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

export function sandboxServiceFromRow(row: Selectable<SandboxServices>): SandboxServiceRecord {
  return {
    id: row.id,
    subject: row.subject,
    name: row.name,
    image: row.image,
    containerId: row.container_id,
    status: row.status,
    error: row.error,
    host: row.host,
    ports: portsOf(row.ports),
    exports: exportsOf(row.exports),
    createdAt: new Date(row.created_at),
    lastUsedAt: new Date(row.last_used_at),
    expiresAt: new Date(row.expires_at),
  };
}

export function sandboxServiceValues(service: Parameters<SandboxServiceStore['insert']>[0]) {
  return {
    id: service.id,
    subject: service.subject,
    name: service.name,
    image: service.image,
    status: 'starting',
    exports: JSON.stringify(service.exports),
    expires_at: service.expiresAt,
  };
}

export function sandboxServicePatch(change: Parameters<SandboxServiceStore['update']>[1]) {
  return {
    ...(change.status !== undefined ? { status: change.status } : {}),
    ...(change.error !== undefined ? { error: change.error } : {}),
    ...(change.containerId !== undefined ? { container_id: change.containerId } : {}),
    ...(change.host !== undefined ? { host: change.host } : {}),
    ...(change.ports !== undefined ? { ports: JSON.stringify(change.ports) } : {}),
  };
}
