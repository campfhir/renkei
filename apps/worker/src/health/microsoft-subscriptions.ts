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

import { getDataStore } from '@renkei/db';
import { getPublicBaseUrl } from '@renkei/settings';
import { MICROSOFT } from '@renkei/provider-grants';
import { deleteGraphSubscription, listGraphSubscriptions } from '@renkei/connector-microsoft';
import type { AuthedFetch } from '@renkei/delegate-client';
import { logger } from '../logger';
import { whoHas } from '../log-actor';
import { resolveMicrosoftAccess } from '../handlers/microsoft-access';
import type { ActorFields } from '@renkei/db';
import { ensureMicrosoftSubscriptions, runSubscriptionSync } from '../handlers/microsoft-sync';

const COMPONENT = 'microsoft/subscription-health';

/** Same cadence as the WebEx sweep; renewal margin is 24h, so plenty. */
export const MICROSOFT_SUBSCRIPTION_INTERVAL_MS = 15 * 60_000;

/** A cursor this stale means notifications are not arriving; catch up. */
const STALE_SYNC_MS = 6 * 60 * 60 * 1000;

/**
 * Delete subscriptions that exist at Graph, point at THIS deployment, and
 * have no row here. Best-effort: a failure leaves the orphan delivering,
 * which is where it already was.
 */
async function reapOrphanedGraphSubscriptions(
  accountId: string,
  owner: ActorFields,
  auth: AuthedFetch,
  baseUrl: string
): Promise<void> {
  const listed = await listGraphSubscriptions(auth);
  if (!listed.ok) {
    logger.warn(
      "{actor}'s Graph subscriptions could not be listed; an orphaned one, if any, keeps delivering until it expires: {error}",
      {
        component: COMPONENT,
        ...owner,
        accountId,
        error: typeof listed.err.message === 'string' ? listed.err.message.slice(0, 200) : '',
      }
    );
    return;
  }

  const known = new Set(
    (await getDataStore().webhookSubscriptions.listForAccount(MICROSOFT, accountId)).flatMap(
      (row) => (row.subscriptionId ? [row.subscriptionId] : [])
    )
  );

  for (const subscription of listed.val) {
    if (known.has(subscription.id)) continue;
    // Ours only: same origin AND this account's path segment.
    const url = subscription.notificationUrl ?? '';
    if (!url.startsWith(baseUrl) || !url.includes(`/${accountId}`)) continue;

    const deleted = await deleteGraphSubscription(auth, subscription.id);
    logger.warn(
      "a Graph subscription to {actor}'s {resource} had no row in this deployment; {outcome}",
      {
        component: COMPONENT,
        ...owner,
        accountId,
        subscriptionId: subscription.id,
        resource: subscription.resource ?? '(unknown resource)',
        succeeded: deleted.ok,
        outcome: deleted.ok
          ? 'it was deleted'
          : 'deleting it failed, so it keeps delivering until it expires',
      }
    );
  }
}

export async function sweepMicrosoftSubscriptions(): Promise<void> {
  const baseUrl = getPublicBaseUrl();
  if (!baseUrl) {
    logger.warn('the public base URL is not set; the Microsoft subscription sweep did nothing', {
      component: COMPONENT,
    });
    return;
  }

  const store = getDataStore();

  let grants: Array<{ accountId: string }>;
  try {
    grants = await store.providerGrants.listWithMetadata(MICROSOFT);
  } catch (error) {
    logger.error('the Microsoft 365 grants could not be listed; this sweep did nothing: {error}', {
      component: COMPONENT,
      error: error instanceof Error ? error.message : String(error),
    });
    return;
  }

  // Rows whose grant vanished (deleted outside the disconnect route) serve
  // nobody and would never renew — drop them.
  const grantKeys = new Set(grants.map((g) => g.accountId));
  const allRows = await store.webhookSubscriptions.listForProvider(MICROSOFT);
  for (const row of allRows) {
    if (!grantKeys.has(row.accountId)) {
      await store.webhookSubscriptions.delete(row.id);
      logger.warn(
        'dropped a Graph subscription row to {resource} whose Microsoft 365 grant is gone; it served nobody',
        {
          component: COMPONENT,
          accountId: row.accountId,
          resource: row.resource,
        }
      );
    }
  }

  for (const { accountId } of grants) {
    const owner = await whoHas(accountId);
    try {
      const access = await resolveMicrosoftAccess(accountId);
      const rows = await ensureMicrosoftSubscriptions(access, baseUrl);
      // ensure returns only rows the user opted into — catching up on a
      // row it withheld would index a category the user turned off.
      const desiredIds = new Set(rows.map((row) => row.id));

      // RECONCILE THE OTHER DIRECTION. A subscription can survive at Graph
      // with no row here — a grant deleted outside the disconnect route, a
      // restore from a backup, a database moved between hosts. Graph then
      // delivers to it until it expires, and every delivery is a
      // notification we cannot attribute and must drop. Deleting it is the
      // only thing that actually stops that.
      //
      // Scoped by notificationUrl, NOT merely by "absent from our table":
      // one Entra app registration is commonly shared by several
      // deployments, and a dev box reaping by table-absence alone would
      // happily delete production's subscriptions.
      await reapOrphanedGraphSubscriptions(accountId, owner, access.auth, baseUrl);

      const staleBefore = Date.now() - STALE_SYNC_MS;
      const stale = await store.webhookSubscriptions.listStale(
        MICROSOFT,
        accountId,
        new Date(staleBefore)
      );
      for (const row of stale) {
        if (!desiredIds.has(row.id)) continue;
        const synced = await runSubscriptionSync(access, {
          id: row.id,
          resource: row.resource,
          subscription_id: row.subscriptionId,
          client_state: row.clientState,
          expires_at: row.expiresAt,
          delta_link: row.deltaLink,
        });
        if (synced.changed > 0 || synced.removed > 0) {
          // Loud on purpose: catch-up finding changes means notifications
          // were being missed until now.
          logger.warn(
            "a catch-up delta round over {actor}'s {resource} found {changed} changed and {removed} removed item(s); notifications had been missed until now",
            {
              component: COMPONENT,
              ...owner,
              accountId,
              resource: row.resource,
              changed: synced.changed,
              removed: synced.removed,
            }
          );
        }
      }
    } catch (error) {
      logger.warn(
        "{actor}'s Microsoft 365 subscriptions could not be checked this pass; they are tried again next sweep: {error}",
        {
          component: COMPONENT,
          ...owner,
          accountId,
          error: error instanceof Error ? error.message : String(error),
        }
      );
    }
  }
}
