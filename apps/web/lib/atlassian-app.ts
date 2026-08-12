/**
 * The Atlassian OAuth app registration, from the database.
 *
 * Client id, scopes and redirect URI are connector configuration
 * (connector_configs, provider 'atlassian'); the client secret is sealed
 * with the deployment key. Nothing about the Atlassian app lives in the
 * environment — an org-admin stores it through the connectors API.
 */

import { parseEncryptionKey } from '@renkei/crypto';
import { readConnectorConfigCached } from '@renkei/connector-config';
import { logger } from '@/lib/logger';

export const ATLASSIAN_CONNECTOR = 'atlassian';
/**
 * The second Atlassian app ("Renkei JSM") — JSM + Ops scopes on their own
 * grant, because all-of scope enforcement × the consent-URL length cliff
 * makes the combined union unfittable on one app.
 */
export const ATLASSIAN_JSM_CONNECTOR = 'atlassian-jsm';
/**
 * The third Atlassian app ("Renkei Confluence") — Confluence's own product
 * API, on its own dedicated grant. Not the same site's API as Jira/JSM, so
 * it doesn't share a consent-URL budget with either.
 */
export const ATLASSIAN_CONFLUENCE_CONNECTOR = 'atlassian-confluence';

// The scope catalog lives in atlassian-scopes.ts (pure data, client-importable
// — the admin form renders it as checkboxes); re-exported here for the server
// routes that already import it from this module.
import {
  DEFAULT_ATLASSIAN_SCOPES,
  DEFAULT_ATLASSIAN_JSM_SCOPES,
  DEFAULT_ATLASSIAN_CONFLUENCE_SCOPES,
  usableAtlassianCeiling,
  usableAtlassianJsmCeiling,
  usableAtlassianConfluenceCeiling,
} from '@/lib/atlassian-scopes';
export {
  DEFAULT_ATLASSIAN_SCOPES,
  DEFAULT_ATLASSIAN_JSM_SCOPES,
  DEFAULT_ATLASSIAN_CONFLUENCE_SCOPES,
};

export interface AtlassianApp {
  clientId: string;
  clientSecret: string;
  scopes: string;
  redirectUri: string;
}

/**
 * The tenant's Atlassian app, or null when not (fully) configured — the
 * caller answers 503, because without an app registration no Atlassian flow
 * can start. `origin` supplies the default redirect URI so authorize and
 * token-exchange always derive the same value.
 */
export async function getAtlassianApp(
  tenantId: string,
  origin: string
): Promise<AtlassianApp | null> {
  return readApp(tenantId, origin, ATLASSIAN_CONNECTOR, usableAtlassianCeiling);
}

/** The tenant's second Atlassian app (JSM + Ops), same contract. */
export async function getAtlassianJsmApp(
  tenantId: string,
  origin: string
): Promise<AtlassianApp | null> {
  return readApp(tenantId, origin, ATLASSIAN_JSM_CONNECTOR, usableAtlassianJsmCeiling);
}

/** The tenant's third Atlassian app (Confluence), same contract. */
export async function getAtlassianConfluenceApp(
  tenantId: string,
  origin: string
): Promise<AtlassianApp | null> {
  return readApp(
    tenantId,
    origin,
    ATLASSIAN_CONFLUENCE_CONNECTOR,
    usableAtlassianConfluenceCeiling
  );
}

async function readApp(
  tenantId: string,
  origin: string,
  connector: string,
  usableCeiling: (stored: string | null) => string[]
): Promise<AtlassianApp | null> {
  const keyResult = parseEncryptionKey(process.env.TOKEN_ENCRYPTION_KEY || '');
  if (!keyResult.ok) {
    logger.error('TOKEN_ENCRYPTION_KEY is missing or malformed', {
      component: 'connectors/atlassian',
      tenantId,
    });
    return null;
  }

  const configResult = await readConnectorConfigCached(tenantId, connector, keyResult.val);
  if (!configResult.ok) {
    logger.error('Could not read atlassian connector config', {
      component: 'connectors/atlassian',
      tenantId,
    });
    return null;
  }
  const config = configResult.val;
  if (!config || !config.enabled) return null;

  const clientId = config.settings.clientId;
  const clientSecret = config.secrets.clientSecret;
  if (typeof clientId !== 'string' || !clientId || !clientSecret) {
    logger.warn('atlassian connector config missing clientId or clientSecret', {
      component: 'connectors/atlassian',
      tenantId,
    });
    return null;
  }

  // The ceiling filter keeps only scopes this connector's catalog knows;
  // settings saved before the granular migration (or before the app split)
  // degrade to the connector's default set until an admin re-saves.
  const scopes = usableCeiling(
    typeof config.settings.scopes === 'string' ? config.settings.scopes : null
  ).join(' ');
  const redirectUri =
    typeof config.settings.redirectUri === 'string' && config.settings.redirectUri
      ? config.settings.redirectUri
      : `${origin}/api/oauth/callback`;

  return { clientId, clientSecret, scopes, redirectUri };
}
