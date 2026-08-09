/**
 * The microsoft/* event handlers.
 *
 * grant.connected — the connect-time bootstrap: create the grant's Graph
 * subscriptions and run the initial delta backfill. Enqueued by the OAuth
 * callback because the subscription handshake calls our webhook route
 * synchronously and the backfill is minutes of work, not callback work.
 *
 * change-notification — the ingestion workhorse: a notification names a
 * subscription; the handler runs a delta round from that row's cursor.
 * Notification ids are hints; delta is the truth.
 *
 * lifecycle — Graph's own health channel: reauthorizationRequired renews
 * now; subscriptionRemoved clears the row so ensure recreates it.
 */

import { getDatabase } from '@renkei/db';
import { getPublicBaseUrl } from '@renkei/settings';
import { renewGraphSubscription } from '@renkei/connector-microsoft';
import { MICROSOFT } from '@renkei/provider-grants';
import { sql } from 'kysely';
import type { ClaimedEvent } from '../queue';
import type { EventHandler } from '../handlers';
import { resolveMicrosoftAccess } from './microsoft-access';
import { ensureMicrosoftSubscriptions, runSubscriptionSync } from './microsoft-sync';
import { logger } from '../logger';

const COMPONENT = 'microsoft/events';

function payloadOf(event: ClaimedEvent): Record<string, unknown> {
  const payload: unknown = event.payload;
  return typeof payload === 'object' && payload !== null && !Array.isArray(payload)
    ? { ...payload }
    : {};
}

function requireString(payload: Record<string, unknown>, key: string): string {
  const value = payload[key];
  if (typeof value !== 'string' || !value) {
    throw new Error(`microsoft event payload has no ${key}`);
  }
  return value;
}

export function createMicrosoftGrantConnectedHandler(): EventHandler {
  return async (event) => {
    const payload = payloadOf(event);
    const accountId = requireString(payload, 'accountId');
    const tenantId = event.tenant_id;

    const baseUrl = getPublicBaseUrl();
    if (!baseUrl) {
      // Retryable on purpose: once an operator sets the public base URL the
      // retry (or the sweep) completes the bootstrap.
      throw new Error('public base URL not set; cannot mint Graph notification URLs');
    }

    const access = await resolveMicrosoftAccess(tenantId, accountId);
    const rows = await ensureMicrosoftSubscriptions(tenantId, access, baseUrl);

    // Initial backfill: one bounded delta round per resource. Idempotent —
    // a retry after a partial pass re-runs into upserts.
    let indexed = 0;
    for (const row of rows) {
      const synced = await runSubscriptionSync(tenantId, access, row);
      indexed += synced.changed;
    }
    logger.info('microsoft bootstrap complete: {subscriptions} subscriptions, {indexed} objects', {
      component: COMPONENT,
      tenantId,
      subscriptions: rows.length,
      indexed,
    });
  };
}

export function createMicrosoftChangeNotificationHandler(): EventHandler {
  return async (event) => {
    const payload = payloadOf(event);
    const accountId = requireString(payload, 'accountId');
    const subscriptionId = requireString(payload, 'subscriptionId');
    const tenantId = event.tenant_id;

    const dbResult = getDatabase();
    if (!dbResult.ok) throw new Error('database unavailable');
    const row = await dbResult.val
      .selectFrom('webhook_subscriptions')
      .select(['id', 'resource', 'subscription_id', 'client_state', 'expires_at', 'delta_link'])
      .where('tenant_id', '=', tenantId)
      .where('provider', '=', MICROSOFT)
      .where('account_id', '=', accountId)
      .where('subscription_id', '=', subscriptionId)
      .executeTakeFirst();
    if (!row) {
      // Disconnected between delivery and processing — nothing to sync.
      logger.info('notification for a subscription that no longer exists; dropping', {
        component: COMPONENT,
        tenantId,
        subscriptionId,
      });
      return;
    }

    const access = await resolveMicrosoftAccess(tenantId, accountId);
    const synced = await runSubscriptionSync(tenantId, access, row);
    logger.info('delta round for {resource}: {changed} changed, {removed} removed', {
      component: COMPONENT,
      tenantId,
      resource: row.resource,
      changed: synced.changed,
      removed: synced.removed,
    });
  };
}

export function createMicrosoftLifecycleHandler(): EventHandler {
  return async (event) => {
    const payload = payloadOf(event);
    const accountId = requireString(payload, 'accountId');
    const subscriptionId = requireString(payload, 'subscriptionId');
    const lifecycleEvent = typeof payload.lifecycleEvent === 'string' ? payload.lifecycleEvent : '';
    const tenantId = event.tenant_id;

    const dbResult = getDatabase();
    if (!dbResult.ok) throw new Error('database unavailable');
    const db = dbResult.val;

    if (lifecycleEvent === 'reauthorizationRequired') {
      const access = await resolveMicrosoftAccess(tenantId, accountId);
      const renewed = await renewGraphSubscription(access.accessToken, subscriptionId);
      if (renewed.ok) {
        await db
          .updateTable('webhook_subscriptions')
          .set({ expires_at: renewed.val.expiresAt, updated_at: sql`NOW()` })
          .where('tenant_id', '=', tenantId)
          .where('provider', '=', MICROSOFT)
          .where('subscription_id', '=', subscriptionId)
          .execute();
        return;
      }
      // Renewal refused — fall through to the removed path so the sweep
      // recreates from scratch.
      logger.warn('reauthorization renewal failed; clearing for recreate', {
        component: COMPONENT,
        tenantId,
        subscriptionId,
      });
    }

    // subscriptionRemoved / missed / failed renewal: clear the provider-side
    // identity so the next ensure pass (sweep, or the next connect) creates
    // a fresh subscription. The delta cursor survives — no re-backfill.
    await db
      .updateTable('webhook_subscriptions')
      .set({ subscription_id: null, expires_at: null, updated_at: sql`NOW()` })
      .where('tenant_id', '=', tenantId)
      .where('provider', '=', MICROSOFT)
      .where('subscription_id', '=', subscriptionId)
      .execute();
    logger.warn('lifecycle {lifecycleEvent}: subscription cleared for recreate', {
      component: COMPONENT,
      tenantId,
      lifecycleEvent: lifecycleEvent || '(unknown)',
    });
  };
}
