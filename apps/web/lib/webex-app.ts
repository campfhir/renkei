/**
 * The WebEx user-integration app registration, from the database.
 *
 * Connector 'webex-user' — deliberately separate from 'webex', the org bot.
 * The bot ingests what it is invited to see; this is the Integration
 * (developer.webex.com → Create an Integration) through which a user grants
 * Renkei their own read access. Client id and scopes are settings; the
 * client secret is sealed with the deployment key.
 */

import { parseEncryptionKey } from '@renkei/crypto';
import { readConnectorConfigCached } from '@renkei/connector-config';
import { logger } from '@/lib/logger';

export const WEBEX_USER_CONNECTOR = 'webex-user';

// The scope catalog lives in webex-scopes.ts (pure data, client-importable —
// the admin form renders it as checkboxes); re-exported here for the server
// routes that already import it from this module.
import { DEFAULT_WEBEX_USER_SCOPES } from '@/lib/webex-scopes';
export { DEFAULT_WEBEX_USER_SCOPES };

export interface WebexUserApp {
  clientId: string;
  clientSecret: string;
  scopes: string;
  redirectUri: string;
}

/** The tenant's WebEx integration, or null when not (fully) configured. */
export async function getWebexUserApp(
  tenantId: string,
  origin: string
): Promise<WebexUserApp | null> {
  const keyResult = parseEncryptionKey(process.env.TOKEN_ENCRYPTION_KEY || '');
  if (!keyResult.ok) {
    logger.error('[WebexApp] TOKEN_ENCRYPTION_KEY is missing or malformed', { tenantId });
    return null;
  }

  const configResult = await readConnectorConfigCached(
    tenantId,
    WEBEX_USER_CONNECTOR,
    keyResult.val
  );
  if (!configResult.ok) {
    logger.error('[WebexApp] Could not read webex-user connector config', { tenantId });
    return null;
  }
  const config = configResult.val;
  if (!config || !config.enabled) return null;

  const clientId = config.settings.clientId;
  const clientSecret = config.secrets.clientSecret;
  if (typeof clientId !== 'string' || !clientId || !clientSecret) {
    logger.warn('[WebexApp] webex-user connector config missing clientId or clientSecret', {
      tenantId,
    });
    return null;
  }

  const scopes =
    typeof config.settings.scopes === 'string' && config.settings.scopes
      ? config.settings.scopes
      : DEFAULT_WEBEX_USER_SCOPES;
  const redirectUri =
    typeof config.settings.redirectUri === 'string' && config.settings.redirectUri
      ? config.settings.redirectUri
      : `${origin}/api/oauth/callback`;

  return { clientId, clientSecret, scopes, redirectUri };
}
