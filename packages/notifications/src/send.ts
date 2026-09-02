/**
 * Turning one notification into an OS-level push, for every device a
 * person has subscribed from.
 *
 * Best-effort in the same sense `agent_notifications` writes are: the run
 * already happened, so a failed push here costs reach, never correctness.
 * Nothing in this module throws past its own boundary — see the two
 * try/catches, one around the whole send and one around each device.
 */

import webpush from 'web-push';
import type { Agent } from 'node:https';
import type { Kysely } from 'kysely';
import type { DB } from '@renkei/db';
import { getPublicBaseUrl } from '@renkei/settings';
import { getVapidKeys } from './vapid';
import { listSubscriptions, deleteSubscriptionByEndpoint } from './subscriptions';

export interface PushPayload {
  title: string;
  body: string;
  /** Coalesces the way the toast pile and the OS banner already do — see
   *  desktop-notifications.tsx and public/sw.js. */
  tag: string;
  /**
   * The connector's own link (a Jira issue, a WebEx space…), kept on the
   * payload for parity with the in-app row but deliberately NOT what a
   * click opens — see `appUrl`.
   */
  refUrl: string | null;
  icon?: string;
}

/** VAPID requires a contact identifying the sender; a URL is as valid a
 *  claim as a mailto: address, and this deployment always has one of the
 *  two. `.invalid` is the reserved placeholder TLD (RFC 2606) for when it
 *  hasn't been configured — never a real, possibly-someone-else's domain. */
function vapidSubject(): string {
  return getPublicBaseUrl() ?? 'mailto:push@renkei.invalid';
}

export type PushLogger = (message: string, meta: Record<string, unknown>) => void;

export interface SendPushOptions {
  log?: PushLogger;
  /** Escape hatch for tests standing in a push service on a self-signed
   *  cert — never set by a real caller. */
  agent?: Agent;
}

/**
 * Where a click on the OS banner lands: Renkei's own notifications page,
 * never the connector's own link (see `sw.js`'s `notificationclick` — the
 * page a person is looking AT should never depend on which connector an
 * agent happened to touch). Null when the tenant id doesn't resolve to a
 * slug, which the caller falls back on the same as no link at all.
 */
async function inAppNotificationsPath(db: Kysely<DB>, tenantId: string): Promise<string | null> {
  const tenant = await db
    .selectFrom('tenants')
    .select('slug')
    .where('id', '=', tenantId)
    .executeTakeFirst()
    .catch(() => undefined);
  return tenant ? `/${tenant.slug}/notifications` : null;
}

export async function sendPush(
  db: Kysely<DB>,
  tenantId: string,
  subject: string,
  encryptionKey: Buffer,
  payload: PushPayload,
  options: SendPushOptions = {}
): Promise<void> {
  const { log, agent } = options;
  try {
    const subscriptions = await listSubscriptions(db, tenantId, subject);
    if (subscriptions.length === 0) return;

    const { publicKey, privateKey } = await getVapidKeys(db, encryptionKey);
    const appUrl = await inAppNotificationsPath(db, tenantId);
    const body = JSON.stringify({
      title: payload.title,
      body: payload.body,
      tag: payload.tag,
      refUrl: payload.refUrl,
      appUrl,
      icon: payload.icon ?? '/icon.svg',
    });
    const vapidDetails = { subject: vapidSubject(), publicKey, privateKey };

    await Promise.all(
      subscriptions.map(async (subscription) => {
        try {
          await webpush.sendNotification(subscription, body, { vapidDetails, agent });
        } catch (error) {
          const statusCode = webPushStatusCode(error);
          // The browser itself revoked this subscription — no retry will
          // ever land, so it is dead weight from here on.
          if (statusCode === 404 || statusCode === 410) {
            await deleteSubscriptionByEndpoint(db, tenantId, subscription.endpoint);
            return;
          }
          log?.('push send failed for tenant {tenantId}', {
            component: '@renkei/notifications',
            tenantId,
            statusCode,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      })
    );
  } catch (error) {
    log?.('push send skipped for tenant {tenantId}', {
      component: '@renkei/notifications',
      tenantId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function webPushStatusCode(error: unknown): number | null {
  if (typeof error !== 'object' || error === null || !('statusCode' in error)) return null;
  return typeof error.statusCode === 'number' ? error.statusCode : null;
}
