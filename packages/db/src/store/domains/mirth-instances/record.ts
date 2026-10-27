import type { Selectable } from 'kysely';
import type { MirthInstances } from '../../../db.types';
import type { MirthConnectionRecord, MirthInstanceInput, MirthInstanceRecord } from './types';

export function mirthInstanceFromRow(row: Selectable<MirthInstances>): MirthInstanceRecord {
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

export function mirthConnectionFromRow(row: {
  username: string;
  permissions: string[];
  encrypted_credentials: string;
}): MirthConnectionRecord {
  return {
    username: row.username,
    permissions: row.permissions,
    encryptedCredentials: row.encrypted_credentials,
  };
}

export function instanceValues(instance: MirthInstanceInput) {
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
