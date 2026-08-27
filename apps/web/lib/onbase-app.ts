/**
 * The OnBase registration, from the database.
 *
 * Connector 'onbase': unlike every SaaS connector, there is no vendor host
 * or Renkei-registered app — the customer runs their own OnBase API Server
 * and Hyland IdP, and registers a client for Renkei on that IdP. All of it
 * is tenant configuration: the API server base URL, the IdP issuer, the
 * client id and the IdP scope name are settings; the client secret (absent
 * for a public PKCE client) is sealed with the deployment key.
 *
 * The web app never dials either host — apps/worker-onbase does (see
 * lib/onbase/service-client.ts) — so the URLs here are handed to the
 * worker and to the user's browser, never fetched from this process.
 */

import { parseEncryptionKey } from '@renkei/crypto';
import { readConnectorConfigCached } from '@renkei/connector-config';
import { logger } from '@/lib/logger';

export const ONBASE_CONNECTOR = 'onbase';

export interface OnBaseApp {
  apiBaseUrl: string;
  idpIssuer: string;
  clientId: string;
  /** Null for a public PKCE client. */
  clientSecret: string | null;
  /** The API-resource scope name configured on the IdP (5_document_management.json). */
  idpScopeName: string;
  allowInsecureHttp: boolean;
  redirectUri: string;
}

/** The scope string a connect asks the IdP for. */
export function onbaseAuthorizeScopes(app: Pick<OnBaseApp, 'idpScopeName'>): string {
  // openid: the id_token whose `sub` becomes the grant's account id.
  // offline_access: a refresh token, so the grant outlives one session.
  return `openid offline_access ${app.idpScopeName}`;
}

/** The tenant's OnBase registration, or null when not (fully) configured. */
export async function getOnBaseApp(tenantId: string, origin: string): Promise<OnBaseApp | null> {
  const keyResult = parseEncryptionKey(process.env.TOKEN_ENCRYPTION_KEY || '');
  if (!keyResult.ok) {
    logger.error('TOKEN_ENCRYPTION_KEY is missing or malformed', {
      component: 'connectors/onbase',
      tenantId,
    });
    return null;
  }

  const configResult = await readConnectorConfigCached(tenantId, ONBASE_CONNECTOR, keyResult.val);
  if (!configResult.ok) {
    logger.error('Could not read onbase connector config', {
      component: 'connectors/onbase',
      tenantId,
    });
    return null;
  }
  const config = configResult.val;
  if (!config || !config.enabled) return null;

  const apiBaseUrl = config.settings.apiBaseUrl;
  const idpIssuer = config.settings.idpIssuer;
  const clientId = config.settings.clientId;
  const idpScopeName = config.settings.idpScopeName;
  if (
    typeof apiBaseUrl !== 'string' ||
    !apiBaseUrl ||
    typeof idpIssuer !== 'string' ||
    !idpIssuer ||
    typeof clientId !== 'string' ||
    !clientId ||
    typeof idpScopeName !== 'string' ||
    !idpScopeName
  ) {
    logger.warn('onbase connector config is incomplete', {
      component: 'connectors/onbase',
      tenantId,
    });
    return null;
  }

  return {
    apiBaseUrl,
    idpIssuer,
    clientId,
    clientSecret:
      typeof config.secrets.clientSecret === 'string' && config.secrets.clientSecret
        ? config.secrets.clientSecret
        : null,
    idpScopeName,
    allowInsecureHttp: config.settings.allowInsecureHttp === true,
    redirectUri: `${origin}/api/oauth/callback`,
  };
}
