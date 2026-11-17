/**
 * The Microsoft Fabric app registration, from the database.
 *
 * Connector 'fabric': a THIRD Entra app registration (entra.microsoft.com →
 * App registrations, Web platform, delegated permissions on "Power BI
 * Service" — the API Fabric's scopes live under) through which a person
 * grants Renkei the right to work in Fabric as them. Its own app, row,
 * grant provider (FABRIC) and capability key, as Entra Developer has: an
 * Entra token is minted for one resource, so Fabric cannot ride the
 * Microsoft 365 grant even if it wanted to. The shape is the same: client
 * id, directory (tenant) id and scopes are settings; the client secret is
 * sealed with the deployment key.
 */

import { loadKeyring } from '@renkei/crypto';
import { readConnectorConfigCached } from '@renkei/connector-config';
import { logger } from '@/lib/logger';
import { DEFAULT_FABRIC_SCOPES } from '@/lib/fabric-scopes';
import type { MicrosoftApp } from '@/lib/microsoft-app';

export const FABRIC_CONNECTOR = 'fabric';
export { DEFAULT_FABRIC_SCOPES };

/** The tenant's Fabric app registration, or null when not (fully) configured. */
export async function getFabricApp(origin: string): Promise<MicrosoftApp | null> {
  const keyResult = loadKeyring('TOKEN_ENCRYPTION_KEY');
  if (!keyResult.ok) {
    logger.error(
      'TOKEN_ENCRYPTION_KEY is missing or malformed, so the Microsoft Fabric registration cannot be read; no Fabric connection can start',
      { component: 'connectors/fabric' }
    );
    return null;
  }

  const configResult = await readConnectorConfigCached(FABRIC_CONNECTOR, keyResult.val);
  if (!configResult.ok) {
    logger.error(
      'the Microsoft Fabric connector config could not be read; no Fabric connection can start',
      { component: 'connectors/fabric' }
    );
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
      'the Microsoft Fabric connector is switched on but its config lacks a client id, directory id or client secret; no Fabric connection can start',
      { component: 'connectors/fabric' }
    );
    return null;
  }

  const scopes =
    typeof config.settings.scopes === 'string' && config.settings.scopes
      ? config.settings.scopes
      : DEFAULT_FABRIC_SCOPES;
  const redirectUri =
    typeof config.settings.redirectUri === 'string' && config.settings.redirectUri
      ? config.settings.redirectUri
      : `${origin}/api/oauth/callback`;

  return { clientId, clientSecret, directoryTenantId, scopes, redirectUri };
}
