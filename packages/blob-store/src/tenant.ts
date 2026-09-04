/**
 * The org's own store. An operator configures Azure Blob Storage for the
 * organization on the Organization → Storage page; the row lives in
 * `connector_configs` under the `blob-storage` key, its account key
 * sealed like every other connector secret. The environment (config.ts)
 * remains the fallback — a single-org deployment can still wire storage
 * on the containers — and neither configured means closed: uploads are
 * off, tools' files are not kept, and the model is told not to produce
 * any.
 *
 * Stores are built once per configuration and kept on globalThis like
 * the environment singleton; the connector-config cache bounds how long
 * a saved change takes to reach a running process (its TTL), and the
 * admin route drops that cache in the process that saved.
 */

import { ok, err } from '@campfhir/safe-functions/helpers';
import type { Result } from '@campfhir/safe-functions/types';
import { parseEncryptionKey } from '@renkei/crypto';
import { readConnectorConfigCached } from '@renkei/connector-config';
import { blobStoreConfig, type BlobStoreConfig } from './config';
import { createAzureBlobStore } from './azure';
import type { BlobStore } from './contract';

/** The connector_configs key the Storage page writes. */
export const BLOB_STORAGE_CONNECTOR = 'blob-storage';

interface TenantStoreState {
  store: BlobStore;
  fingerprint: string;
}

declare global {
  var __renkeiTenantBlobStores: Map<string, TenantStoreState> | undefined;
}

function stores(): Map<string, TenantStoreState> {
  return (globalThis.__renkeiTenantBlobStores ??= new Map());
}

/** The store's settings as the admin page reads and writes them (no secret). */
export interface StoredBlobSettings {
  provider: 'azure';
  account: string;
  container: string;
  endpoint: string | null;
}

/**
 * The org's configuration, validated the same way as the environment's:
 * the row's fields are laid over an empty environment and read back.
 */
export function blobStoreConfigOfRow(
  settings: Record<string, unknown>,
  secrets: Record<string, string>
): Result<BlobStoreConfig, 'BLOB_UNCONFIGURED'> {
  const text = (value: unknown): string | undefined =>
    typeof value === 'string' && value.trim() ? value : undefined;
  return blobStoreConfig({
    BLOB_STORE_PROVIDER: text(settings.provider) ?? 'azure',
    AZURE_BLOB_ACCOUNT: text(settings.account),
    AZURE_BLOB_KEY: text(secrets.key),
    AZURE_BLOB_CONTAINER: text(settings.container),
    AZURE_BLOB_ENDPOINT: text(settings.endpoint),
  });
}

/** The configuration in force for an org: its own row, else the environment. */
export async function resolveTenantBlobConfig(
  tenantId: string
): Promise<Result<BlobStoreConfig, 'BLOB_UNCONFIGURED'>> {
  const key = parseEncryptionKey(process.env.TOKEN_ENCRYPTION_KEY || '');
  if (key.ok) {
    const row = await readConnectorConfigCached(tenantId, BLOB_STORAGE_CONNECTOR, key.val);
    if (row.ok && row.val && row.val.enabled) {
      return blobStoreConfigOfRow(row.val.settings, row.val.secrets);
    }
  }
  return blobStoreConfig();
}

/** A store for one configuration, however it was arrived at (the admin page's test uses this). */
export function blobStoreFor(config: BlobStoreConfig): BlobStore {
  return createAzureBlobStore(config);
}

export async function resolveTenantBlobStore(
  tenantId: string
): Promise<Result<BlobStore, 'BLOB_UNCONFIGURED'>> {
  const config = await resolveTenantBlobConfig(tenantId);
  if (!config.ok) return config;
  const fingerprint = JSON.stringify(config.val);
  const known = stores().get(tenantId);
  if (known && known.fingerprint === fingerprint) return ok(known.store);
  const store = blobStoreFor(config.val);
  stores().set(tenantId, { store, fingerprint });
  return ok(store);
}

/** Whether this org can hold files at all — the "attachments on" switch. */
export async function tenantBlobStoreConfigured(tenantId: string): Promise<boolean> {
  return (await resolveTenantBlobConfig(tenantId)).ok;
}

/** Test hook. */
export function resetTenantBlobStores(): void {
  globalThis.__renkeiTenantBlobStores = undefined;
}

export function tenantBlobStoreUnavailable(): Result<never, 'BLOB_UNCONFIGURED'> {
  return err('BLOB_UNCONFIGURED' as const, {
    message: 'No file storage is configured for this organization.',
  });
}
