/**
 * Mapping a Zoom webhook delivery back to a user grant. Zoom deliveries
 * carry the meeting HOST's zoom user id (host_id) — which is exactly the
 * provider_account_id the OAuth callback stored — so the host's own grant
 * is the credential every re-fetch runs under. No grant means the host
 * never connected Zoom: their meetings are not ours to ingest, and the
 * caller skips WITHOUT failing (a retry cannot conjure a grant).
 */

import { sql } from 'kysely';
import { parseEncryptionKey } from '@renkei/crypto';
import { readConnectorConfigCached } from '@renkei/connector-config';
import { getDatabase } from '@renkei/db';
import { getGrant, refreshGrantTokens, ZOOM, ZoomAdapter } from '@renkei/provider-grants';
import { logger } from '../logger';

/** Refresh when the token is inside this window of expiry. */
const REFRESH_MARGIN_MS = 2 * 60 * 1000;

export interface ZoomHostAccess {
  accessToken: string;
  accountId: string;
  /** Lowercased — the refId owner segment. */
  hostEmail: string;
}

/**
 * The host's live Zoom access, or null when the host has no grant (skip).
 * Configuration problems still throw — those belong on last_error.
 */
export async function resolveZoomHostAccess(
  tenantId: string,
  hostId: string | null,
  hostEmail: string | null
): Promise<ZoomHostAccess | null> {
  const keyResult = parseEncryptionKey(process.env.TOKEN_ENCRYPTION_KEY || '');
  if (!keyResult.ok) throw new Error('TOKEN_ENCRYPTION_KEY is missing or malformed');

  const configResult = await readConnectorConfigCached(tenantId, ZOOM, keyResult.val);
  if (!configResult.ok) {
    throw new Error(`could not read zoom connector config for tenant ${tenantId}`);
  }
  const config = configResult.val;
  const clientSecret = config?.secrets.clientSecret;
  if (!config || !config.enabled || !clientSecret) {
    throw new Error(`zoom connector is not configured or disabled for tenant ${tenantId}`);
  }

  const dbResult = getDatabase();
  if (!dbResult.ok) throw new Error('database unavailable');

  // host_id is the stored provider_account_id; email is the fallback for
  // deliveries that carry only host_email.
  let row = hostId
    ? await dbResult.val
        .selectFrom('provider_grants')
        .select(['provider_account_id', 'metadata'])
        .where('tenant_id', '=', tenantId)
        .where('provider', '=', ZOOM)
        .where('provider_account_id', '=', hostId)
        .executeTakeFirst()
    : undefined;
  if (!row && hostEmail) {
    row = await dbResult.val
      .selectFrom('provider_grants')
      .select(['provider_account_id', 'metadata'])
      .where('tenant_id', '=', tenantId)
      .where('provider', '=', ZOOM)
      .where(sql<string>`metadata->>'email'`, '=', hostEmail.toLowerCase())
      .executeTakeFirst();
  }
  if (!row) return null;

  const grantResult = await getGrant(ZOOM, tenantId, row.provider_account_id, keyResult.val);
  if (!grantResult.ok || !grantResult.val) return null;
  let grant = grantResult.val;

  if (new Date(grant.expiresAt).getTime() - Date.now() < REFRESH_MARGIN_MS) {
    const refreshed = await refreshGrantTokens(
      new ZoomAdapter(clientSecret),
      tenantId,
      grant.accountId,
      keyResult.val,
      logger
    );
    if (!refreshed.ok) {
      if (refreshed.err.type === 'GRANT_REVOKED') {
        // The grant was just deleted; ingestion for this host ends here.
        logger.warn('zoom grant revoked during refresh; skipping', {
          component: 'zoom/ingest',
          tenantId,
        });
        return null;
      }
      throw new Error(`could not refresh zoom token for host ${grant.accountId}`);
    }
    grant = { ...grant, accessToken: refreshed.val.accessToken };
  }

  const email =
    typeof grant.metadata.email === 'string' && grant.metadata.email
      ? grant.metadata.email.toLowerCase()
      : (hostEmail ?? '').toLowerCase();
  if (!email) {
    throw new Error(`zoom grant for ${grant.accountId} carries no email for refIds`);
  }

  return { accessToken: grant.accessToken, accountId: grant.accountId, hostEmail: email };
}
