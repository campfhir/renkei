/**
 * Per-grant Atlassian access for the worker, for both the Jira and
 * Confluence apps — read the grant, refresh proactively when it is near
 * expiry, hand back the token plus the cloud id every gateway URL needs.
 *
 * Mirrors resolveMicrosoftAccess deliberately, including the proactive
 * refresh: the web side refreshes reactively on a 401 because a user is
 * waiting and one retry is cheap, but a sweep has no user to retry for and
 * a mid-round 401 would abandon a whole poll.
 *
 * Throws with operator-readable reasons — an unconfigured connector or a
 * revoked grant surfaces on the dead-lettered event's last_error, which is
 * where an operator will look.
 */

import { parseEncryptionKey } from '@renkei/crypto';
import { readConnectorConfigCached } from '@renkei/connector-config';
import {
  getGrant,
  refreshGrantTokens,
  readAtlassianMetadata,
  AtlassianAdapter,
} from '@renkei/provider-grants';
import { logger } from '../logger';

/** Refresh when the token is inside this window of expiry. */
const REFRESH_MARGIN_MS = 2 * 60 * 1000;

export interface AtlassianAccess {
  accessToken: string;
  accountId: string;
  /** The Atlassian site — every gateway path is /ex/{product}/{cloudId}/… */
  cloudId: string;
}

/**
 * @param provider The grant provider key — ATLASSIAN for Jira,
 *   ATLASSIAN_CONFLUENCE for Confluence. It doubles as the connector-config
 *   key, since each app stores its own client id/secret.
 */
export async function resolveAtlassianAccess(
  tenantId: string,
  accountId: string,
  provider: string
): Promise<AtlassianAccess> {
  const keyResult = parseEncryptionKey(process.env.TOKEN_ENCRYPTION_KEY || '');
  if (!keyResult.ok) {
    throw new Error('TOKEN_ENCRYPTION_KEY is missing or malformed');
  }

  const configResult = await readConnectorConfigCached(tenantId, provider, keyResult.val);
  if (!configResult.ok) {
    throw new Error(`could not read ${provider} connector config for tenant ${tenantId}`);
  }
  const config = configResult.val;
  const clientSecret = config?.secrets.clientSecret;
  if (!config || !config.enabled || !clientSecret) {
    throw new Error(`${provider} connector is not configured or disabled for tenant ${tenantId}`);
  }

  const grantResult = await getGrant(provider, tenantId, accountId, keyResult.val);
  if (!grantResult.ok || !grantResult.val) {
    throw new Error(`no ${provider} grant for account ${accountId} (disconnected?)`);
  }
  let grant = grantResult.val;

  if (new Date(grant.expiresAt).getTime() - Date.now() < REFRESH_MARGIN_MS) {
    // The adapter is provider-parameterized, so all three Atlassian apps
    // refresh through the same class against their own rows.
    const refreshed = await refreshGrantTokens(
      new AtlassianAdapter(clientSecret, provider),
      tenantId,
      accountId,
      keyResult.val,
      logger
    );
    if (!refreshed.ok) {
      throw new Error(
        refreshed.err.type === 'GRANT_REVOKED'
          ? `${provider} grant for ${accountId} was revoked`
          : `could not refresh ${provider} token for ${accountId}`
      );
    }
    grant = { ...grant, accessToken: refreshed.val.accessToken };
  }

  const site = readAtlassianMetadata(grant.metadata);
  if (!site.cloudId) {
    throw new Error(`${provider} grant for ${accountId} carries no cloud id`);
  }

  return { accessToken: grant.accessToken, accountId, cloudId: site.cloudId };
}
