/**
 * Per-tenant WebEx context: the bot client and the bot's own identity,
 * resolved from database connector configuration (connector_configs) rather
 * than the environment — connectors are provisioned per tenant by
 * org-admins, and the worker must serve every tenant's events from one
 * process.
 *
 * Contexts cache briefly so per-event resolution doesn't become per-event
 * queries and getMe calls; a rotated bot token takes effect within the TTL.
 */

import { parseEncryptionKey } from '@renkei/crypto';
import { readConnectorConfigCached } from '@renkei/connector-config';
import { WebexClient, WEBEX_CONNECTOR } from '@renkei/connector-webex';

export interface WebexTenantContext {
  client: Pick<WebexClient, 'getMessage' | 'isRoomMember'>;
  botPersonId: string | null;
}

interface CacheEntry {
  context: WebexTenantContext;
  expiresAt: number;
}

const CONTEXT_TTL_MS = 5 * 60_000;
const contextCache = new Map<string, CacheEntry>();

/**
 * Resolve the tenant's WebEx context, or throw with a reason that reads well
 * on a dead-lettered event — an unconfigured connector is an operator
 * problem, and the queue's last_error is where they will look.
 */
export async function resolveWebexContext(tenantId: string): Promise<WebexTenantContext> {
  const cached = contextCache.get(tenantId);
  if (cached && cached.expiresAt > Date.now()) return cached.context;

  const keyResult = parseEncryptionKey(process.env.TOKEN_ENCRYPTION_KEY || '');
  if (!keyResult.ok) {
    throw new Error('TOKEN_ENCRYPTION_KEY is missing or malformed');
  }

  const configResult = await readConnectorConfigCached(tenantId, WEBEX_CONNECTOR, keyResult.val);
  if (!configResult.ok) {
    throw new Error(`could not read webex connector config for tenant ${tenantId}`);
  }
  const config = configResult.val;
  const botToken = config?.secrets.botToken;
  if (!config || !config.enabled || !botToken) {
    throw new Error(`webex connector is not configured or disabled for tenant ${tenantId}`);
  }

  const client = new WebexClient(botToken);
  // Best effort: without the bot's identity the handler still works, it just
  // cannot filter the bot's own messages out of ingestion.
  const me = await client.getMe();
  if (!me.ok) {
    console.warn(
      `[worker] could not resolve WebEx bot identity for tenant ${tenantId}; own-message filter disabled`
    );
  }

  const context: WebexTenantContext = { client, botPersonId: me.ok ? me.val.id : null };
  contextCache.set(tenantId, { context, expiresAt: Date.now() + CONTEXT_TTL_MS });
  return context;
}

/** Test hook. */
export function clearWebexContextCache(): void {
  contextCache.clear();
}
