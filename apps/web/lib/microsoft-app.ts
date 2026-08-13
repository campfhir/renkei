/**
 * The Microsoft (Entra) app registration, from the database.
 *
 * Connector 'microsoft': the Entra app registration (portal.azure.com →
 * App registrations, Web platform, delegated Graph permissions) through
 * which a user grants Renkei their own Outlook access. Client id, directory
 * (tenant) id and scopes are settings; the client secret is sealed with the
 * deployment key.
 *
 * directoryTenantId is required rather than defaulted to `common`: this is
 * a single-org deployment (RENKEI.md Decision #5), and the org-specific
 * authority is what keeps personal Microsoft accounts out.
 */

import { parseEncryptionKey } from '@renkei/crypto';
import { readConnectorConfigCached } from '@renkei/connector-config';
import { logger } from '@/lib/logger';

export const MICROSOFT_CONNECTOR = 'microsoft';

// The scope catalog lives in microsoft-scopes.ts (pure data, client-importable
// — the admin form renders it as checkboxes); re-exported here for the server
// routes that already import it from this module.
import { DEFAULT_MICROSOFT_SCOPES } from '@/lib/microsoft-scopes';
export { DEFAULT_MICROSOFT_SCOPES };

export interface MicrosoftApp {
  clientId: string;
  clientSecret: string;
  directoryTenantId: string;
  scopes: string;
  redirectUri: string;
}

/** The tenant's Entra app registration, or null when not (fully) configured. */
export async function getMicrosoftApp(
  tenantId: string,
  origin: string
): Promise<MicrosoftApp | null> {
  const keyResult = parseEncryptionKey(process.env.TOKEN_ENCRYPTION_KEY || '');
  if (!keyResult.ok) {
    logger.error('TOKEN_ENCRYPTION_KEY is missing or malformed', {
      component: 'connectors/microsoft',
      tenantId,
    });
    return null;
  }

  const configResult = await readConnectorConfigCached(
    tenantId,
    MICROSOFT_CONNECTOR,
    keyResult.val
  );
  if (!configResult.ok) {
    logger.error('Could not read microsoft connector config', {
      component: 'connectors/microsoft',
      tenantId,
    });
    return null;
  }
  const config = configResult.val;
  if (!config || !config.enabled) return null;

  const clientId = config.settings.clientId;
  const directoryTenantId = config.settings.directoryTenantId;
  const clientSecret = config.secrets.clientSecret;
  if (
    typeof clientId !== 'string' ||
    !clientId ||
    typeof directoryTenantId !== 'string' ||
    !directoryTenantId ||
    !clientSecret
  ) {
    logger.warn('microsoft connector config missing clientId, directoryTenantId or clientSecret', {
      component: 'connectors/microsoft',
      tenantId,
    });
    return null;
  }

  const scopes =
    typeof config.settings.scopes === 'string' && config.settings.scopes
      ? config.settings.scopes
      : DEFAULT_MICROSOFT_SCOPES;
  const redirectUri =
    typeof config.settings.redirectUri === 'string' && config.settings.redirectUri
      ? config.settings.redirectUri
      : `${origin}/api/oauth/callback`;

  return { clientId, clientSecret, directoryTenantId, scopes, redirectUri };
}
