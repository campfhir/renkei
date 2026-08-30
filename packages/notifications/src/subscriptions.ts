/**
 * One device's standing invitation for the server to wake it — see
 * migration 067 for why this exists alongside `agent_notifications` rather
 * than replacing it.
 */

import { randomUUID } from 'node:crypto';
import type { Kysely } from 'kysely';
import type { DB } from '@renkei/db';

export interface PushSubscriptionInput {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

export interface StoredPushSubscription {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

/**
 * Idempotent: `PushManager.subscribe()` on an already-subscribed browser
 * returns the SAME endpoint, so a repeat call upserts the row in place
 * rather than piling up duplicates that would each get their own push.
 */
export async function saveSubscription(
  db: Kysely<DB>,
  tenantId: string,
  subject: string,
  subscription: PushSubscriptionInput
): Promise<void> {
  await db
    .insertInto('push_subscriptions')
    .values({
      id: randomUUID(),
      tenant_id: tenantId,
      subject,
      endpoint: subscription.endpoint,
      p256dh: subscription.keys.p256dh,
      auth: subscription.keys.auth,
    })
    .onConflict((oc) =>
      oc.columns(['tenant_id', 'endpoint']).doUpdateSet({
        subject,
        p256dh: subscription.keys.p256dh,
        auth: subscription.keys.auth,
      })
    )
    .execute();
}

/** Scoped by subject too, structurally — a borrowed endpoint deletes nothing
 *  belonging to somebody else. */
export async function deleteSubscription(
  db: Kysely<DB>,
  tenantId: string,
  subject: string,
  endpoint: string
): Promise<void> {
  await db
    .deleteFrom('push_subscriptions')
    .where('tenant_id', '=', tenantId)
    .where('subject', '=', subject)
    .where('endpoint', '=', endpoint)
    .execute();
}

/** Every device one person has opted in from, for fanning a send out. */
export async function listSubscriptions(
  db: Kysely<DB>,
  tenantId: string,
  subject: string
): Promise<StoredPushSubscription[]> {
  const rows = await db
    .selectFrom('push_subscriptions')
    .select(['endpoint', 'p256dh', 'auth'])
    .where('tenant_id', '=', tenantId)
    .where('subject', '=', subject)
    .execute();
  return rows.map((row) => ({
    endpoint: row.endpoint,
    keys: { p256dh: row.p256dh, auth: row.auth },
  }));
}

/** Drop a subscription the push service itself reports gone (404/410) — the
 *  browser revoked it, and no retry will ever land. */
export async function deleteSubscriptionByEndpoint(
  db: Kysely<DB>,
  tenantId: string,
  endpoint: string
): Promise<void> {
  await db
    .deleteFrom('push_subscriptions')
    .where('tenant_id', '=', tenantId)
    .where('endpoint', '=', endpoint)
    .execute();
}
