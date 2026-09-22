/**
 * The GitHub App registration, from the database.
 *
 * Client id, and (Renkei's own capability ceiling) scopes live in
 * connector_configs (provider 'github'); the client secret is sealed with
 * the deployment key. A GitHub App also carries an App ID and a numeric
 * slug/name for building the installation link the connect card shows —
 * both non-secret, so they live in `settings` alongside the client id.
 */

import { parseEncryptionKey } from '@renkei/crypto';
import { readConnectorConfigCached } from '@renkei/connector-config';
import { logger } from '@/lib/logger';
import { usableGitHubCeiling, DEFAULT_GITHUB_SCOPES } from '@/lib/github-scopes';

export { DEFAULT_GITHUB_SCOPES };

export const GITHUB_CONNECTOR = 'github';

export interface GitHubApp {
  clientId: string;
  clientSecret: string;
  /** Renkei's own capability ceiling — never sent to GitHub (see github-scopes.ts). */
  scopes: string;
  redirectUri: string;
  /** The App's public slug (github.com/apps/<slug>), for the install link. Empty until set. */
  appSlug: string;
}

/**
 * The tenant's GitHub App, or null when not (fully) configured — the caller
 * answers 503, because without an app registration no GitHub flow can
 * start. `origin` supplies the default redirect URI so authorize and
 * token-exchange always derive the same value.
 */
export async function getGitHubApp(tenantId: string, origin: string): Promise<GitHubApp | null> {
  const keyResult = parseEncryptionKey(process.env.TOKEN_ENCRYPTION_KEY || '');
  if (!keyResult.ok) {
    logger.error('TOKEN_ENCRYPTION_KEY is missing or malformed', {
      component: 'connectors/github',
      tenantId,
    });
    return null;
  }

  const configResult = await readConnectorConfigCached(tenantId, GITHUB_CONNECTOR, keyResult.val);
  if (!configResult.ok) {
    logger.error('Could not read github connector config', {
      component: 'connectors/github',
      tenantId,
    });
    return null;
  }
  const config = configResult.val;
  if (!config || !config.enabled) return null;

  const clientId = config.settings.clientId;
  const clientSecret = config.secrets.clientSecret;
  if (typeof clientId !== 'string' || !clientId || !clientSecret) {
    logger.warn('github connector config missing clientId or clientSecret', {
      component: 'connectors/github',
      tenantId,
    });
    return null;
  }

  const scopes = usableGitHubCeiling(
    typeof config.settings.scopes === 'string' ? config.settings.scopes : null
  ).join(' ');
  const redirectUri =
    typeof config.settings.redirectUri === 'string' && config.settings.redirectUri
      ? config.settings.redirectUri
      : `${origin}/api/oauth/callback`;
  const appSlug = typeof config.settings.appSlug === 'string' ? config.settings.appSlug : '';

  return { clientId, clientSecret, scopes, redirectUri, appSlug };
}
