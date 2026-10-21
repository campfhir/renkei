/**
 * The Salesforce CRM app registration, from the database.
 *
 * Connector 'salesforce': an External Client App (or connected app) the
 * organization creates in ITS OWN Salesforce org — Renkei publishes no
 * packaged app. The consumer key and the org's My Domain are settings; the
 * consumer secret is sealed with the deployment key; `scopes` is Renkei's
 * own capability ceiling (salesforce-scopes.ts), never sent to Salesforce.
 *
 * The My Domain is the whole host story: authorize, token and revoke live
 * there, a token's instance_url must equal it (the OAuth callback refuses
 * anything else), and the delegate lets a Salesforce token travel to that
 * host alone (apps/worker-delegate/src/providers.ts).
 */

import { loadKeyring } from '@renkei/crypto';
import { readConnectorConfigCached } from '@renkei/connector-config';
import { parseMyDomain } from '@renkei/connector-salesforce';
import { logger } from '@/lib/logger';
import { DEFAULT_SALESFORCE_SCOPES, usableSalesforceCeiling } from '@/lib/salesforce-scopes';

export const SALESFORCE_CONNECTOR = 'salesforce';
export { DEFAULT_SALESFORCE_SCOPES };

export interface SalesforceApp {
  clientId: string;
  clientSecret: string;
  /** The org's My Domain origin, `https://<domain>.my.salesforce.com`. */
  myDomain: string;
  /** Renkei's own capability ceiling — never sent to Salesforce. */
  scopes: string;
  redirectUri: string;
}

/** The tenant's Salesforce app, or null when not (fully) configured. */
export async function getSalesforceApp(origin: string): Promise<SalesforceApp | null> {
  const keyResult = loadKeyring('TOKEN_ENCRYPTION_KEY');
  if (!keyResult.ok) {
    logger.error('TOKEN_ENCRYPTION_KEY is missing or malformed', {
      component: 'connectors/salesforce',
    });
    return null;
  }

  const configResult = await readConnectorConfigCached(SALESFORCE_CONNECTOR, keyResult.val);
  if (!configResult.ok) {
    logger.error('Could not read salesforce connector config', {
      component: 'connectors/salesforce',
    });
    return null;
  }
  const config = configResult.val;
  if (!config || !config.enabled) return null;

  const clientId = config.settings.clientId;
  const clientSecret = config.secrets.clientSecret;
  const myDomain = parseMyDomain(
    typeof config.settings.myDomain === 'string' ? config.settings.myDomain : ''
  );
  if (typeof clientId !== 'string' || !clientId || !clientSecret || !myDomain.ok) {
    logger.warn('salesforce connector config missing clientId, clientSecret or a My Domain', {
      component: 'connectors/salesforce',
    });
    return null;
  }

  const scopes = usableSalesforceCeiling(
    typeof config.settings.scopes === 'string' ? config.settings.scopes : null
  ).join(' ');
  const redirectUri =
    typeof config.settings.redirectUri === 'string' && config.settings.redirectUri
      ? config.settings.redirectUri
      : `${origin}/api/oauth/callback`;

  return { clientId, clientSecret, myDomain: myDomain.origin, scopes, redirectUri };
}
