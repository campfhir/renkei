/**
 * The Organization → Storage page's server side: reading and writing the
 * org's blob store row and probing a configuration before it is saved.
 * Shared by the two admin routes so they cannot drift on what a valid
 * row is.
 */

import { parseEncryptionKey } from '@renkei/crypto';
import {
  getConnectorConfig,
  setConnectorConfig,
  invalidateConnectorConfigCache,
} from '@renkei/connector-config';
import {
  BLOB_STORAGE_CONNECTOR,
  blobStoreConfigOfRow,
  blobStoreFor,
  blobStoreConfig,
} from '@renkei/blob-store';

export interface StorageView {
  /** A row exists for the org. */
  configured: boolean;
  enabled: boolean;
  provider: 'azure';
  account: string | null;
  container: string | null;
  endpoint: string | null;
  hasKey: boolean;
  /** The deployment's environment carries a store the org falls back to. */
  environmentFallback: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function encryptionKey(): Buffer | null {
  const key = parseEncryptionKey(process.env.TOKEN_ENCRYPTION_KEY || '');
  return key.ok ? key.val : null;
}

export async function readStorage(tenantId: string): Promise<StorageView | 'ERROR'> {
  const key = encryptionKey();
  if (!key) return 'ERROR';
  const row = await getConnectorConfig(tenantId, BLOB_STORAGE_CONNECTOR, key);
  if (!row.ok) return 'ERROR';
  const setting = (name: string): string | null => {
    const value = row.val?.settings[name];
    return typeof value === 'string' && value ? value : null;
  };
  return {
    configured: row.val !== null,
    enabled: row.val?.enabled ?? false,
    provider: 'azure',
    account: setting('account'),
    container: setting('container'),
    endpoint: setting('endpoint'),
    hasKey: Boolean(row.val?.secrets.key),
    environmentFallback: blobStoreConfig().ok,
  };
}

export interface StorageInput {
  enabled: boolean;
  account: string;
  container: string;
  endpoint: string | null;
  /** Empty keeps the stored key. */
  key: string | null;
}

export function parseStorageInput(body: unknown): StorageInput | string {
  if (!isRecord(body)) return 'JSON body required';
  const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');
  const account = text(body.account);
  if (!/^[a-z0-9]{3,24}$/.test(account)) {
    return 'The storage account name is 3–24 lowercase letters and digits.';
  }
  const container = text(body.container) || 'renkei-chat';
  if (!/^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])?$/.test(container)) {
    return 'The container name is 3–63 lowercase letters, digits or hyphens.';
  }
  const endpoint = text(body.endpoint);
  if (endpoint) {
    let url: URL;
    try {
      url = new URL(endpoint);
    } catch {
      return 'The endpoint must be an absolute URL.';
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:')
      return 'The endpoint must be http(s).';
  }
  const key = text(body.key);
  if (key && Buffer.from(key, 'base64').length === 0) return 'The account key is not valid base64.';
  return {
    enabled: typeof body.enabled === 'boolean' ? body.enabled : true,
    account,
    container,
    endpoint: endpoint || null,
    key: key || null,
  };
}

/** The row as it would be saved from this input — the stored key when none was typed. */
export async function mergeStorage(
  tenantId: string,
  input: StorageInput
): Promise<{ settings: Record<string, unknown>; secrets: Record<string, string> } | 'ERROR'> {
  const key = encryptionKey();
  if (!key) return 'ERROR';
  const existing = await getConnectorConfig(tenantId, BLOB_STORAGE_CONNECTOR, key);
  const storedKey = existing.ok && existing.val ? existing.val.secrets.key : undefined;
  const accountKey = input.key ?? storedKey;
  return {
    settings: {
      provider: 'azure',
      account: input.account,
      container: input.container,
      endpoint: input.endpoint,
    },
    secrets: accountKey ? { key: accountKey } : {},
  };
}

export async function saveStorage(
  tenantId: string,
  input: StorageInput
): Promise<StorageView | string> {
  const key = encryptionKey();
  if (!key) return 'Server misconfigured';
  const merged = await mergeStorage(tenantId, input);
  if (merged === 'ERROR') return 'Could not read the stored configuration';
  if (!merged.secrets.key) return 'The account key is required the first time.';
  const written = await setConnectorConfig(
    tenantId,
    BLOB_STORAGE_CONNECTOR,
    { enabled: input.enabled, settings: merged.settings, secrets: merged.secrets },
    key
  );
  if (!written.ok) return 'Could not store the configuration';
  invalidateConnectorConfigCache(tenantId, BLOB_STORAGE_CONNECTOR);
  const view = await readStorage(tenantId);
  return view === 'ERROR' ? 'Saved, but the configuration could not be read back' : view;
}

/**
 * Proves a configuration works before it is saved: the container is
 * created if missing, a probe object is written, read and deleted. Any
 * step failing comes back as a plain sentence.
 */
export async function testStorage(
  tenantId: string,
  input: StorageInput
): Promise<{ ok: boolean; detail: string }> {
  const merged = await mergeStorage(tenantId, input);
  if (merged === 'ERROR') return { ok: false, detail: 'Could not read the stored configuration.' };
  if (!merged.secrets.key) return { ok: false, detail: 'Enter the account key to test.' };
  const config = blobStoreConfigOfRow(merged.settings, merged.secrets);
  if (!config.ok)
    return { ok: false, detail: config.err.message ?? 'The configuration is incomplete.' };
  const store = blobStoreFor(config.val);
  const host = (() => {
    try {
      return new URL(config.val.endpoint).host;
    } catch {
      return config.val.endpoint;
    }
  })();
  const at = `Tested ${host} as account "${config.val.account}", container "${config.val.container}".`;
  const why = (error: { type: string; message?: string }) => error.message ?? error.type;

  const container = await store.ensureContainer();
  if (!container.ok) {
    return {
      ok: false,
      detail: `Creating or reaching the container failed: ${why(container.err)} ${at}`,
    };
  }
  const probeKey = `probe/${tenantId}/${Date.now()}`;
  const probe = new TextEncoder().encode('renkei storage probe');
  const put = await store.putObject(probeKey, probe, 'text/plain');
  if (!put.ok) return { ok: false, detail: `Writing a probe failed: ${why(put.err)} ${at}` };
  const got = await store.getObject(probeKey);
  // Whatever the read said, the probe was written: never leave it behind.
  const removed = await store.deleteObject(probeKey);
  if (!got.ok) {
    return { ok: false, detail: `Writing worked, reading back failed: ${why(got.err)} ${at}` };
  }
  if (!removed.ok && removed.err.type !== 'NOT_FOUND') {
    return {
      ok: false,
      detail: `Wrote and read a probe, deleting it failed: ${why(removed.err)} ${at}`,
    };
  }
  return {
    ok: true,
    detail: `Wrote, read and removed a probe in "${config.val.container}" on ${config.val.account} via ${host}.`,
  };
}
