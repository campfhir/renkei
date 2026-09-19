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
import { getNotificationPrefs } from '@renkei/user-prefs';
import { getVapidKeys } from './vapid';
import { listSubscriptions, deleteSubscriptionByEndpoint } from './subscriptions';
import { isExternalNotificationUrl } from './targets';

export interface PushPayload {
  title: string;
  body: string;
  /** Coalesces the way the toast pile and the OS banner already do — see
   *  desktop-notifications.tsx and public/sw.js. */
  tag: string;
  /**
   * The connector's own link (a Jira issue, a WebEx space…) — what a click
   * opens when the person has "open in the source application" on (their
   * default) and the link really is outside Renkei; see `pushClickTarget`.
   */
  refUrl: string | null;
  icon?: string;
  /**
   * The `agent_notifications` row this push announces. With it, a click
   * goes through the row's open route, which marks it read and then sends
   * the browser on to wherever the click was going anyway. Without it a
   * click still lands, but nothing is marked read.
   */
  notificationId?: string;
  /**
   * Where in Renkei a click lands, when not the notifications page: a
   * same-origin path (a chat, say — its reply or its permission ask is
   * answered there and nowhere else). Ignored for an external target.
   */
  appPath?: string;
  /**
   * This push repeats something already shown inline on `appPath` — a
   * question or permission ask, say. The service worker skips the OS
   * banner when that exact page is the one open and focused, rather than
   * whenever any Renkei tab happens to be; every other push (a ticket
   * filed, a run finishing) is news no matter what is on screen, so it
   * defaults to false.
   */
  quiet?: boolean;
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
 * What the service worker (public/sw.js) gets, and acts on when the banner
 * is clicked. `openUrl` is the one URL it navigates to; `external` says
 * whether that lands outside Renkei (open a new window, leave the person's
 * Renkei tab where it is) or inside it (bring the existing tab forward and
 * take it there). `appUrl` and `refUrl` are kept for a worker built against
 * the older shape, which reads only `appUrl`.
 */
export interface PushWirePayload {
  title: string;
  body: string;
  tag: string;
  icon: string;
  refUrl: string | null;
  appUrl: string;
  openUrl: string;
  external: boolean;
  quiet: boolean;
}

/**
 * Where a click on the OS banner lands. Three cases:
 *   - the row has an id: its open route, which marks it read and redirects
 *     to whichever of the two below applies at click time;
 *   - the link is the provider's and the person wants the provider: there;
 *   - otherwise Renkei — the chat or page the push names, else the
 *     notifications list.
 * The route decides the final target again on the click (the preference
 * may have changed meanwhile); `external` here is the worker's hint for
 * how to open it, nothing more.
 */
export function pushClickTarget(input: {
  tenantId: string;
  slug: string;
  refUrl: string | null;
  notificationId?: string;
  appPath?: string;
  openInSourceApp: boolean;
}): Pick<PushWirePayload, 'appUrl' | 'openUrl' | 'external'> {
  const appUrl =
    input.appPath && input.appPath.startsWith('/') && !input.appPath.startsWith('//')
      ? input.appPath
      : `/${input.slug}/notifications`;
  const external = input.openInSourceApp && isExternalNotificationUrl(input.refUrl);
  const openUrl = input.notificationId
    ? `/api/tenant/${input.tenantId}/notifications/${input.notificationId}/open`
    : external && input.refUrl
      ? input.refUrl
      : appUrl;
  return { appUrl, openUrl, external };
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

    const [{ publicKey, privateKey }, tenant, prefs] = await Promise.all([
      getVapidKeys(db, encryptionKey),
      db
        .selectFrom('tenants')
        .select('slug')
        .where('id', '=', tenantId)
        .executeTakeFirst()
        .catch(() => undefined),
      getNotificationPrefs(tenantId, subject),
    ]);
    // No slug means no tenant to land in; the click falls back to the
    // app's root, the same as a payload with no link at all.
    const target = tenant
      ? pushClickTarget({
          tenantId,
          slug: tenant.slug,
          refUrl: payload.refUrl,
          ...(payload.notificationId ? { notificationId: payload.notificationId } : {}),
          ...(payload.appPath ? { appPath: payload.appPath } : {}),
          openInSourceApp: prefs.openInSourceApp,
        })
      : { appUrl: '/', openUrl: '/', external: false };
    const wire: PushWirePayload = {
      title: payload.title,
      body: payload.body,
      tag: payload.tag,
      icon: payload.icon ?? '/icon.svg',
      refUrl: payload.refUrl,
      quiet: payload.quiet === true,
      ...target,
    };
    const body = JSON.stringify(wire);
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
