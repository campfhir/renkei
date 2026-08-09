/**
 * The Zoom app registration, from the database.
 *
 * Connector 'zoom': a user-managed General app (marketplace.zoom.us →
 * Develop → Build App) through which a user grants Renkei access to their
 * own meetings and recordings. Client id and scopes are settings; the
 * client secret and the webhook Secret Token (Features → Access in the
 * Marketplace app) are sealed with the deployment key.
 *
 * The Secret Token is what verifies webhook deliveries AND answers Zoom's
 * endpoint.url_validation challenge — without it the webhook route refuses
 * everything, by design.
 */

import { parseEncryptionKey } from '@renkei/crypto';
import { readConnectorConfigCached } from '@renkei/connector-config';
import { logger } from '@/lib/logger';

export const ZOOM_CONNECTOR = 'zoom';

// The scope catalog lives in zoom-scopes.ts (pure data, client-importable —
// the admin form renders it as checkboxes); re-exported here for the server
// routes that already import it from this module.
import { DEFAULT_ZOOM_SCOPES } from '@/lib/zoom-scopes';
export { DEFAULT_ZOOM_SCOPES };

export interface ZoomApp {
  clientId: string;
  clientSecret: string;
  /** Marketplace webhook Secret Token; null until the admin saves one. */
  secretToken: string | null;
  scopes: string;
  redirectUri: string;
}

/** The tenant's Zoom app, or null when not (fully) configured. */
export async function getZoomApp(tenantId: string, origin: string): Promise<ZoomApp | null> {
  const keyResult = parseEncryptionKey(process.env.TOKEN_ENCRYPTION_KEY || '');
  if (!keyResult.ok) {
    logger.error('TOKEN_ENCRYPTION_KEY is missing or malformed', {
      component: 'connectors/zoom',
      tenantId,
    });
    return null;
  }

  const configResult = await readConnectorConfigCached(tenantId, ZOOM_CONNECTOR, keyResult.val);
  if (!configResult.ok) {
    logger.error('Could not read zoom connector config', {
      component: 'connectors/zoom',
      tenantId,
    });
    return null;
  }
  const config = configResult.val;
  if (!config || !config.enabled) return null;

  const clientId = config.settings.clientId;
  const clientSecret = config.secrets.clientSecret;
  if (typeof clientId !== 'string' || !clientId || !clientSecret) {
    logger.warn('zoom connector config missing clientId or clientSecret', {
      component: 'connectors/zoom',
      tenantId,
    });
    return null;
  }

  const secretToken =
    typeof config.secrets.secretToken === 'string' && config.secrets.secretToken
      ? config.secrets.secretToken
      : null;
  const scopes =
    typeof config.settings.scopes === 'string' && config.settings.scopes
      ? config.settings.scopes
      : DEFAULT_ZOOM_SCOPES;
  const redirectUri =
    typeof config.settings.redirectUri === 'string' && config.settings.redirectUri
      ? config.settings.redirectUri
      : `${origin}/api/oauth/callback`;

  return { clientId, clientSecret, secretToken, scopes, redirectUri };
}
