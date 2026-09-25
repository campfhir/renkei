/**
 * The Entra Developer app registration, from the database.
 *
 * Connector 'entra-developer': a SECOND Entra app registration
 * (entra.microsoft.com → App registrations, Web platform, delegated Graph
 * permissions for applications, app role assignments and directory
 * lookups) through which a person grants Renkei the right to provision
 * applications as them. Separate from the Microsoft 365 app on purpose —
 * see entra-developer-scopes.ts — but the same shape: client id, directory
 * (tenant) id and scopes are settings; the client secret is sealed with the
 * deployment key. Its own connector_configs row, grant provider
 * (ENTRA_DEVELOPER) and capability key, so connecting one never connects
 * the other.
 */

import { parseEncryptionKey } from '@renkei/crypto';
import { readConnectorConfigCached } from '@renkei/connector-config';
import { logger } from '@/lib/logger';
import { DEFAULT_ENTRA_DEVELOPER_SCOPES } from '@/lib/entra-developer-scopes';
import type { MicrosoftApp } from '@/lib/microsoft-app';

export const ENTRA_DEVELOPER_CONNECTOR = 'entra-developer';
export { DEFAULT_ENTRA_DEVELOPER_SCOPES };

/** The tenant's Entra Developer app registration, or null when not (fully) configured. */
export async function getEntraDeveloperApp(
  tenantId: string,
  origin: string
): Promise<MicrosoftApp | null> {
  const keyResult = parseEncryptionKey(process.env.TOKEN_ENCRYPTION_KEY || '');
  if (!keyResult.ok) {
    logger.error('TOKEN_ENCRYPTION_KEY is missing or malformed', {
      component: 'connectors/entra-developer',
      tenantId,
    });
    return null;
  }

  const configResult = await readConnectorConfigCached(
    tenantId,
    ENTRA_DEVELOPER_CONNECTOR,
    keyResult.val
  );
  if (!configResult.ok) {
    logger.error('Could not read entra-developer connector config', {
      component: 'connectors/entra-developer',
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
    logger.warn(
      'entra-developer connector config missing clientId, directoryTenantId or clientSecret',
      { component: 'connectors/entra-developer', tenantId }
    );
    return null;
  }

  const scopes =
    typeof config.settings.scopes === 'string' && config.settings.scopes
      ? config.settings.scopes
      : DEFAULT_ENTRA_DEVELOPER_SCOPES;
  const redirectUri =
    typeof config.settings.redirectUri === 'string' && config.settings.redirectUri
      ? config.settings.redirectUri
      : `${origin}/api/oauth/callback`;

  return { clientId, clientSecret, directoryTenantId, scopes, redirectUri };
}
