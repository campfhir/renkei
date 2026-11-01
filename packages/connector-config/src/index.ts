/**
 * @renkei/connector-config — the organization's connector configuration, stored in
 * the database rather than the environment (RENKEI.md Decision #13: which
 * connectors an org runs, and with what credentials, is org-admin policy).
 *
 * Secrets are sealed with the deployment key in the same secretbox envelope
 * as provider grants; `settings` stays inspectable jsonb for everything
 * non-secret. Consumers cache reads briefly (see readConnectorConfigCached)
 * so per-event lookups don't turn into per-event queries — a config change
 * takes effect within the TTL, which beats a process restart.
 */

import { configCacheTtlMs as storeConfigCacheTtlMs, getDataStore } from '@renkei/db';
import { encrypt, decrypt } from '@renkei/crypto';
import { ok, err, wrapAsync } from '@campfhir/safe-functions/helpers';
import type { Result } from '@campfhir/safe-functions/types';
import { isRecord } from '@renkei/guards';

export interface ConnectorConfig {
  connector: string;
  enabled: boolean;
  /** Inspectable, non-secret configuration. */
  settings: Record<string, unknown>;
  /** Decrypted secret values (tokens, webhook secrets). */
  secrets: Record<string, string>;
}

export type ConnectorConfigError = 'DB_ERROR' | 'DECRYPTION_ERROR';

function readStringRecord(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {};
  const out: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === 'string') out[key] = entry;
  }
  return out;
}

export async function getConnectorConfig(
  connector: string,
  encryptionKey: Buffer
): Promise<Result<ConnectorConfig | null, ConnectorConfigError>> {
  const rowResult = await wrapAsync(
    () => getDataStore().connectorConfigs.get(connector),
    'DB_ERROR' as const
  );
  if (!rowResult.ok) return rowResult;

  const row = rowResult.val;
  if (!row) return ok(null);

  const secretsJson = decrypt(row.encryptedSecrets, encryptionKey);
  if (!secretsJson.ok) {
    return err('DECRYPTION_ERROR' as const, {
      message: `${connector} secrets did not decrypt: ${secretsJson.err.message ?? secretsJson.err.type}`,
    });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(secretsJson.val);
  } catch {
    return err('DECRYPTION_ERROR' as const, { message: `${connector} secrets are not JSON` });
  }

  return ok({
    connector,
    enabled: row.enabled,
    settings: isRecord(row.settings) ? { ...row.settings } : {},
    secrets: readStringRecord(parsed),
  });
}

export async function setConnectorConfig(
  connector: string,
  config: { enabled: boolean; settings: Record<string, unknown>; secrets: Record<string, string> },
  encryptionKey: Buffer
): Promise<Result<void, 'DB_ERROR'>> {
  const encryptedSecrets = encrypt(JSON.stringify(config.secrets), encryptionKey);
  const result = await wrapAsync(
    () =>
      getDataStore().connectorConfigs.upsert({
        connector,
        enabled: config.enabled,
        settings: config.settings,
        encryptedSecrets,
      }),
    'DB_ERROR' as const
  );

  if (!result.ok) return result;
  return ok();
}

interface CacheEntry {
  value: ConnectorConfig | null;
  expiresAt: number;
}

const configCache = new Map<string, CacheEntry>();

/** How long a cached read is served before the database is asked again. */
export const CONFIG_CACHE_TTL_MS = 60_000;

/**
 * The cache's lifetime: CONFIG_CACHE_TTL_MS, unless RENKEI_CONFIG_CACHE_TTL_MS
 * names another (the browser suite sets 0; see configCacheTtlMs).
 */
export function configCacheTtlMs(env: NodeJS.ProcessEnv = process.env): number {
  return storeConfigCacheTtlMs(CONFIG_CACHE_TTL_MS, env);
}

/**
 * Cached read for hot paths (per-event, per-delivery). Only successful reads
 * are cached — an error must not be remembered as "not configured".
 */
export async function readConnectorConfigCached(
  connector: string,
  encryptionKey: Buffer
): Promise<Result<ConnectorConfig | null, ConnectorConfigError>> {
  const cached = configCache.get(connector);
  if (cached && cached.expiresAt > Date.now()) return ok(cached.value);

  const result = await getConnectorConfig(connector, encryptionKey);
  if (result.ok) {
    configCache.set(connector, { value: result.val, expiresAt: Date.now() + configCacheTtlMs() });
  }
  return result;
}

/** Drop a cached entry — used after setConnectorConfig and by tests. */
export function invalidateConnectorConfigCache(connector?: string): void {
  if (!connector) configCache.clear();
  else configCache.delete(connector);
}
