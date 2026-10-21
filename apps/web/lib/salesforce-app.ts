/**
 * The organization's Salesforce connectors, from the database.
 *
 * One Salesforce connector per Salesforce org the organization works in —
 * production, and each sandbox — all of the same type, each self-contained:
 * its own My Domain, its own External Client App (consumer key in
 * settings, secret sealed under `clientSecret:<key>`), its own on/off switch
 * and capability ceiling, and each person connects each one separately.
 * They live as a list (`settings.orgs`, parsed by @renkei/connector-salesforce)
 * on the `salesforce` connector config row, whose own `enabled` is the
 * type's switch; Renkei publishes no packaged app.
 *
 * A connector's My Domain is its whole host story: authorize, token and
 * revoke live there, a token's instance_url must equal it (the OAuth
 * callback refuses anything else), and the delegate lets that connector's
 * tokens travel to that host alone (apps/worker-delegate/src/providers.ts).
 *
 * The admin connector (`salesforce-admin`) is the same shape on its own
 * config row: each function takes the connector type (lib/salesforce-kinds.ts),
 * the CRM by default.
 */

import { loadKeyring } from '@renkei/crypto';
import { readConnectorConfigCached } from '@renkei/connector-config';
import {
  findOrg,
  orgSecretName,
  orgsFromSettings,
  type SalesforceOrg,
} from '@renkei/connector-salesforce';
import { logger } from '@/lib/logger';
import { DEFAULT_SALESFORCE_SCOPES } from '@/lib/salesforce-scopes';
import { SALESFORCE_CRM_KIND, type SalesforceKind } from '@/lib/salesforce-kinds';

export const SALESFORCE_CONNECTOR = 'salesforce';
export { DEFAULT_SALESFORCE_SCOPES };

/** A connector ready to connect: switched on, with its secret, its ceiling, and the redirect URI. */
export interface SalesforceConnectorApp extends SalesforceOrg {
  clientSecret: string;
  /** Renkei's own capability ceiling — never sent to Salesforce. */
  ceiling: string[];
  redirectUri: string;
}

/** Every connector of a type the organization registered (on or off), or [] when none or unreadable. */
export async function listSalesforceConnectors(
  kind: SalesforceKind = SALESFORCE_CRM_KIND
): Promise<SalesforceOrg[]> {
  const keyResult = loadKeyring('TOKEN_ENCRYPTION_KEY');
  if (!keyResult.ok) return [];
  const configResult = await readConnectorConfigCached(kind.key, keyResult.val);
  if (!configResult.ok || !configResult.val || !configResult.val.enabled) return [];
  return orgsFromSettings(configResult.val.settings);
}

/** One connector, switched on and fully configured, or null. */
export async function getSalesforceConnector(
  origin: string,
  key: string,
  kind: SalesforceKind = SALESFORCE_CRM_KIND
): Promise<SalesforceConnectorApp | null> {
  const keyResult = loadKeyring('TOKEN_ENCRYPTION_KEY');
  if (!keyResult.ok) {
    logger.error('TOKEN_ENCRYPTION_KEY is missing or malformed', {
      component: 'connectors/salesforce',
    });
    return null;
  }
  const configResult = await readConnectorConfigCached(kind.key, keyResult.val);
  if (!configResult.ok) {
    logger.error('Could not read salesforce connector config', {
      component: 'connectors/salesforce',
      type: kind.key,
    });
    return null;
  }
  const config = configResult.val;
  if (!config || !config.enabled) return null;
  const org = findOrg(orgsFromSettings(config.settings), key);
  if (!org || !org.enabled) return null;
  const clientSecret = config.secrets[orgSecretName(org.key)];
  if (!clientSecret) {
    logger.warn('salesforce connector has no consumer secret', {
      component: 'connectors/salesforce',
      type: kind.key,
      connector: org.key,
    });
    return null;
  }
  const redirectUri =
    typeof config.settings.redirectUri === 'string' && config.settings.redirectUri
      ? config.settings.redirectUri
      : `${origin}/api/oauth/callback`;
  return {
    ...org,
    clientSecret,
    ceiling: kind.ceiling(org.scopes.join(' ')),
    redirectUri,
  };
}
