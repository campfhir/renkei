/**
 * Per-grant Microsoft access for the worker: read the grant, refresh
 * proactively through the adapter when it is near expiry, hand back the
 * token plus the identity facts (upn, effective scopes) ingestion builds
 * refIds and subscription sets from.
 *
 * Throws with operator-readable reasons — an unconfigured connector or a
 * revoked grant surfaces on the dead-lettered event's last_error, which is
 * where an operator will look.
 */

import { parseEncryptionKey } from '@renkei/crypto';
import { readConnectorConfigCached } from '@renkei/connector-config';
import { getGrant, refreshGrantTokens, MICROSOFT, MicrosoftAdapter } from '@renkei/provider-grants';
import { logger } from '../logger';

/** Refresh when the token is inside this window of expiry. */
const REFRESH_MARGIN_MS = 2 * 60 * 1000;

export interface MicrosoftAccess {
  accessToken: string;
  accountId: string;
  /** Lowercased — the refId owner segment and purge prefix. */
  upn: string;
  /** granted ?? requested: what tools and subscriptions may cover. */
  scopes: string[];
}

export async function resolveMicrosoftAccess(
  tenantId: string,
  accountId: string
): Promise<MicrosoftAccess> {
  const keyResult = parseEncryptionKey(process.env.TOKEN_ENCRYPTION_KEY || '');
  if (!keyResult.ok) {
    throw new Error('TOKEN_ENCRYPTION_KEY is missing or malformed');
  }

  const configResult = await readConnectorConfigCached(tenantId, MICROSOFT, keyResult.val);
  if (!configResult.ok) {
    throw new Error(`could not read microsoft connector config for tenant ${tenantId}`);
  }
  const config = configResult.val;
  const clientSecret = config?.secrets.clientSecret;
  if (!config || !config.enabled || !clientSecret) {
    throw new Error(`microsoft connector is not configured or disabled for tenant ${tenantId}`);
  }

  const grantResult = await getGrant(MICROSOFT, tenantId, accountId, keyResult.val);
  if (!grantResult.ok || !grantResult.val) {
    throw new Error(`no microsoft grant for account ${accountId} (disconnected?)`);
  }
  let grant = grantResult.val;

  if (new Date(grant.expiresAt).getTime() - Date.now() < REFRESH_MARGIN_MS) {
    const tid =
      typeof grant.metadata.tid === 'string' && grant.metadata.tid
        ? grant.metadata.tid
        : typeof config.settings.directoryTenantId === 'string'
          ? config.settings.directoryTenantId
          : '';
    if (!tid) throw new Error('microsoft grant has no directory tenant id to refresh against');
    const refreshed = await refreshGrantTokens(
      new MicrosoftAdapter(clientSecret, tid),
      tenantId,
      accountId,
      keyResult.val,
      logger
    );
    if (!refreshed.ok) {
      throw new Error(
        refreshed.err.type === 'GRANT_REVOKED'
          ? `microsoft grant for ${accountId} was revoked`
          : `could not refresh microsoft token for ${accountId}`
      );
    }
    grant = { ...grant, accessToken: refreshed.val.accessToken };
  }

  const upn = typeof grant.metadata.upn === 'string' ? grant.metadata.upn.toLowerCase() : '';
  if (!upn) throw new Error(`microsoft grant for ${accountId} carries no upn`);

  return {
    accessToken: grant.accessToken,
    accountId,
    upn,
    scopes: grant.grantedScopes ?? grant.requestedScopes ?? [],
  };
}
