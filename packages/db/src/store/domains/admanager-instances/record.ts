import type { Selectable } from 'kysely';
import type { AdmanagerInstances } from '../../../db.types';
import type {
  AdManagerConnectionRecord,
  AdManagerInstanceInput,
  AdManagerInstanceRecord,
} from './types';

export function adManagerInstanceFromRow(
  row: Selectable<AdmanagerInstances>
): AdManagerInstanceRecord {
  return {
    id: row.id,
    name: row.name,
    environment: row.environment,
    baseUrl: row.base_url,
    tlsVerify: row.tls_verify,
    caPem: row.ca_pem,
    allowInsecureHttp: row.allow_insecure_http,
    enabled: row.enabled,
    settings: row.settings ?? null,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  };
}

export function adManagerConnectionFromRow(row: {
  technician_name: string;
  permissions: string[];
  encrypted_credentials: string;
}): AdManagerConnectionRecord {
  return {
    technicianName: row.technician_name,
    permissions: row.permissions,
    encryptedCredentials: row.encrypted_credentials,
  };
}

export function instanceValues(instance: AdManagerInstanceInput) {
  return {
    name: instance.name,
    environment: instance.environment,
    base_url: instance.baseUrl,
    tls_verify: instance.tlsVerify,
    ...(instance.caPem === undefined ? {} : { ca_pem: instance.caPem }),
    allow_insecure_http: instance.allowInsecureHttp,
    enabled: instance.enabled,
  };
}

/** `(settings - ownedKeys) || values`, as Postgres computes it for a stored object. */
export function mergedSettings(
  stored: unknown,
  settings: AdManagerInstanceInput['settings']
): Record<string, unknown> {
  const base: Record<string, unknown> =
    typeof stored === 'object' && stored !== null && !Array.isArray(stored) ? { ...stored } : {};
  for (const key of settings.ownedKeys) delete base[key];
  return { ...base, ...settings.values };
}
