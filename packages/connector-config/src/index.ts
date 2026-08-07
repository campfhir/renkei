/**
 * @renkei/connector-config — per-tenant connector configuration, stored in
 * the database rather than the environment (RENKEI.md Decision #13: which
 * connectors an org runs, and with what credentials, is org-admin policy).
 *
 * Secrets are sealed with the deployment key in the same secretbox envelope
 * as provider grants; `settings` stays inspectable jsonb for everything
 * non-secret. Consumers cache reads briefly (see readConnectorConfigCached)
 * so per-event lookups don't turn into per-event queries — a config change
 * takes effect within the TTL, which beats a process restart.
 */

import { getDatabase } from '@renkei/db';
import { encrypt, decrypt } from '@renkei/crypto';
import { ok, err, wrapAsync } from '@campfhir/safe-functions/helpers';
import type { Result } from '@campfhir/safe-functions/types';

export interface ConnectorConfig {
  connector: string;
  enabled: boolean;
  /** Inspectable, non-secret configuration. */
  settings: Record<string, unknown>;
  /** Decrypted secret values (tokens, webhook secrets). */
  secrets: Record<string, string>;
}

export type ConnectorConfigError = 'DB_ERROR' | 'DECRYPTION_ERROR';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readStringRecord(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {};
  const out: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === 'string') out[key] = entry;
  }
  return out;
}

export async function getConnectorConfig(
  tenantId: string,
  connector: string,
  encryptionKey: Buffer
): Promise<Result<ConnectorConfig | null, ConnectorConfigError>> {
  const dbResult = getDatabase();
  if (!dbResult.ok) return err('DB_ERROR' as const);

  const rowResult = await wrapAsync(
    () =>
      dbResult.val
        .selectFrom('connector_configs')
        .select(['enabled', 'settings', 'encrypted_secrets'])
        .where('tenant_id', '=', tenantId)
        .where('connector', '=', connector)
        .executeTakeFirst(),
    'DB_ERROR' as const
  );
  if (!rowResult.ok) return rowResult;

  const row = rowResult.val;
  if (!row) return ok(null);

  const secretsJson = decrypt(row.encrypted_secrets, encryptionKey);
  if (!secretsJson.ok) return err('DECRYPTION_ERROR' as const);

  let parsed: unknown;
  try {
    parsed = JSON.parse(secretsJson.val);
  } catch {
    return err('DECRYPTION_ERROR' as const);
  }

  return ok({
    connector,
    enabled: row.enabled,
    settings: isRecord(row.settings) ? { ...row.settings } : {},
    secrets: readStringRecord(parsed),
  });
}

export async function setConnectorConfig(
  tenantId: string,
  connector: string,
  config: { enabled: boolean; settings: Record<string, unknown>; secrets: Record<string, string> },
  encryptionKey: Buffer
): Promise<Result<void, 'DB_ERROR'>> {
  const dbResult = getDatabase();
  if (!dbResult.ok) return err('DB_ERROR' as const);

  const encryptedSecrets = encrypt(JSON.stringify(config.secrets), encryptionKey);
  const settings = JSON.stringify(config.settings);

  const result = await wrapAsync(
    () =>
      dbResult.val
        .insertInto('connector_configs')
        .values({
          tenant_id: tenantId,
          connector,
          enabled: config.enabled,
          settings,
          encrypted_secrets: encryptedSecrets,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .onConflict((oc) =>
          oc.columns(['tenant_id', 'connector']).doUpdateSet({
            enabled: config.enabled,
            settings,
            encrypted_secrets: encryptedSecrets,
            updated_at: new Date().toISOString(),
          })
        )
        .execute(),
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
 * Cached read for hot paths (per-event, per-delivery). Only successful reads
 * are cached — an error must not be remembered as "not configured".
 */
export async function readConnectorConfigCached(
  tenantId: string,
  connector: string,
  encryptionKey: Buffer
): Promise<Result<ConnectorConfig | null, ConnectorConfigError>> {
  const key = `${tenantId}:${connector}`;
  const cached = configCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return ok(cached.value);

  const result = await getConnectorConfig(tenantId, connector, encryptionKey);
  if (result.ok) {
    configCache.set(key, { value: result.val, expiresAt: Date.now() + CONFIG_CACHE_TTL_MS });
  }
  return result;
}

/** Drop a cached entry — used after setConnectorConfig and by tests. */
export function invalidateConnectorConfigCache(tenantId?: string, connector?: string): void {
  if (!tenantId) {
    configCache.clear();
    return;
  }
  for (const key of configCache.keys()) {
    if (key.startsWith(`${tenantId}:`) && (!connector || key === `${tenantId}:${connector}`)) {
      configCache.delete(key);
    }
  }
}
