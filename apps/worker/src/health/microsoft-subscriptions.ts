/**
 * Periodic Microsoft subscription health — the Graph flavor of "connectors
 * silently rot". Graph subscriptions EXPIRE by design (days, not forever),
 * so unlike the WebEx sweep this one is not just repair, it is routine
 * upkeep: renew what is near expiry, recreate what lapsed or was removed,
 * bootstrap grants that somehow never got their set (a dead-lettered
 * connect event), and run a catch-up delta round where notifications have
 * gone quiet — the scheduler-as-producer fallback.
 *
 * Per-grant failures are logged and skipped; one revoked grant must not
 * stall the sweep for the rest.
 */

import { getDatabase } from '@renkei/db';
import { getPublicBaseUrl } from '@renkei/settings';
import { MICROSOFT } from '@renkei/provider-grants';
import { logger } from '../logger';
import { resolveMicrosoftAccess } from '../handlers/microsoft-access';
import { ensureMicrosoftSubscriptions, runSubscriptionSync } from '../handlers/microsoft-sync';

const COMPONENT = 'microsoft/subscription-health';

/** Same cadence as the WebEx sweep; renewal margin is 24h, so plenty. */
export const MICROSOFT_SUBSCRIPTION_INTERVAL_MS = 15 * 60_000;

/** A cursor this stale means notifications are not arriving; catch up. */
const STALE_SYNC_MS = 6 * 60 * 60 * 1000;

export async function sweepMicrosoftSubscriptions(): Promise<void> {
  const baseUrl = getPublicBaseUrl();
  if (!baseUrl) {
    logger.warn('PUBLIC_BASE_URL not set; skipping sweep', { component: COMPONENT });
    return;
  }

  const dbResult = getDatabase();
  if (!dbResult.ok) {
    logger.error('database unavailable', { component: COMPONENT });
    return;
  }
  const db = dbResult.val;

  let grants: Array<{ tenant_id: string; provider_account_id: string }>;
  try {
    grants = await db
      .selectFrom('provider_grants')
      .select(['tenant_id', 'provider_account_id'])
      .where('provider', '=', MICROSOFT)
      .execute();
  } catch (error) {
    logger.error('could not enumerate microsoft grants: {error}', {
      component: COMPONENT,
      error: error instanceof Error ? error.message : String(error),
    });
    return;
  }

  // Rows whose grant vanished (deleted outside the disconnect route) serve
  // nobody and would never renew — drop them.
  const grantKeys = new Set(grants.map((g) => `${g.tenant_id}:${g.provider_account_id}`));
  const allRows = await db
    .selectFrom('webhook_subscriptions')
    .select(['id', 'tenant_id', 'account_id'])
    .where('provider', '=', MICROSOFT)
    .execute();
  for (const row of allRows) {
    if (!grantKeys.has(`${row.tenant_id}:${row.account_id}`)) {
      await db.deleteFrom('webhook_subscriptions').where('id', '=', row.id).execute();
      logger.warn('dropped orphaned subscription row (grant gone)', {
        component: COMPONENT,
        tenantId: row.tenant_id,
      });
    }
  }

  for (const { tenant_id: tenantId, provider_account_id: accountId } of grants) {
    try {
      const access = await resolveMicrosoftAccess(tenantId, accountId);
      const rows = await ensureMicrosoftSubscriptions(tenantId, access, baseUrl);
      // ensure returns only rows the user opted into — catching up on a
      // row it withheld would index a category the user turned off.
      const desiredIds = new Set(rows.map((row) => row.id));

      const staleBefore = Date.now() - STALE_SYNC_MS;
      const stale = await db
        .selectFrom('webhook_subscriptions')
        .select(['id', 'resource', 'subscription_id', 'client_state', 'expires_at', 'delta_link'])
        .where('tenant_id', '=', tenantId)
        .where('provider', '=', MICROSOFT)
        .where('account_id', '=', accountId)
        .where('updated_at', '<', new Date(staleBefore))
        .execute();
      for (const row of stale) {
        if (!desiredIds.has(row.id)) continue;
        const synced = await runSubscriptionSync(tenantId, access, row);
        if (synced.changed > 0 || synced.removed > 0) {
          // Loud on purpose: catch-up finding changes means notifications
          // were being missed until now.
          logger.warn('stale catch-up on {resource}: {changed} changed, {removed} removed', {
            component: COMPONENT,
            tenantId,
            resource: row.resource,
            changed: synced.changed,
            removed: synced.removed,
          });
        }
      }
    } catch (error) {
      logger.warn('sweep skipped grant {accountId}: {error}', {
        component: COMPONENT,
        tenantId,
        accountId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
