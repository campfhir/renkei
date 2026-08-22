/**
 * Expired-grant hygiene: delete provider grants nothing has used for so
 * long that their refresh token is dead anyway.
 *
 * A LIVE grant's `expires_at` sits on a ~1-hour horizon — every tool call,
 * watch poll, or subscription renewal refreshes it forward. A grant whose
 * expiry is months in the past has therefore been touched by NOTHING for
 * months, and every provider Renkei connects expires refresh tokens after
 * ~90 days of inactivity (Atlassian and Microsoft explicitly). Such a row
 * is not a credential anymore — it is stale ciphertext that makes anything
 * still bound to it (a content watch, a webhook row) fail with confusing
 * refresh errors instead of a clean "not connected".
 *
 * Deletion here matches what refresh.ts already does the moment a provider
 * says GRANT_REVOKED — this sweep just reaches the grants nobody asks to
 * refresh. Watches bound to a deleted grant surface a per-row error on
 * their next poll and can be rebound with the watch repair action, cursor
 * intact.
 */

import { sql } from 'kysely';
import { getDatabase } from '@renkei/db';
import { logger } from '../logger';

const COMPONENT = 'grants/expiry-sweep';

/** Every 6 hours — dead grants are not urgent, only accumulating. */
export const EXPIRED_GRANTS_SWEEP_INTERVAL_MS = 6 * 60 * 60_000;

/**
 * How long past expiry a grant must be before it counts as abandoned.
 * 90 days matches the providers' own inactivity expiry — below that a
 * refresh token could in principle still work, and deleting a working
 * credential is the one mistake this sweep must never make.
 */
export const GRANT_STALE_DAYS = 90;

/** Rows deleted per pass — hygiene, not a purge race. */
const MAX_DELETES_PER_PASS = 100;

export async function sweepExpiredGrants(): Promise<void> {
  const dbResult = getDatabase();
  if (!dbResult.ok) {
    logger.error('database unavailable', { component: COMPONENT });
    return;
  }
  const db = dbResult.val;

  let stale: { tenant_id: string; provider: string; provider_account_id: string }[];
  try {
    stale = await db
      .selectFrom('provider_grants')
      .select(['tenant_id', 'provider', 'provider_account_id'])
      .where('expires_at', '<', sql<Date>`NOW() - make_interval(days => ${GRANT_STALE_DAYS})`)
      .limit(MAX_DELETES_PER_PASS)
      .execute();
  } catch (error) {
    logger.error('could not list stale grants: {error}', {
      component: COMPONENT,
      error: error instanceof Error ? error.message : String(error),
    });
    return;
  }
  if (stale.length === 0) return;

  for (const grant of stale) {
    try {
      await db
        .deleteFrom('provider_grants')
        .where('tenant_id', '=', grant.tenant_id)
        .where('provider', '=', grant.provider)
        .where('provider_account_id', '=', grant.provider_account_id)
        // Re-checked in the delete itself: a refresh that landed between the
        // listing and now has moved expires_at forward, and that grant is
        // alive again — the race must lose to the refresh, not to the sweep.
        .where('expires_at', '<', sql<Date>`NOW() - make_interval(days => ${GRANT_STALE_DAYS})`)
        .execute();
      // One line per deletion, with everything needed to answer "where did
      // my connection go" from the logs alone.
      logger.info('deleted expired {provider} grant for account {accountId}', {
        component: COMPONENT,
        tenantId: grant.tenant_id,
        provider: grant.provider,
        accountId: grant.provider_account_id,
        staleDays: GRANT_STALE_DAYS,
      });
    } catch (error) {
      logger.warn('could not delete stale grant: {error}', {
        component: COMPONENT,
        tenantId: grant.tenant_id,
        provider: grant.provider,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
