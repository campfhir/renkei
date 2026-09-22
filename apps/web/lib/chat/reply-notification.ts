/**
 * The "an agent replied while you were away" ping — off by default, and
 * only ever a push: the pop-up pile and the in-app feed already cover a
 * tab that IS in front. `quiet: true` tells the service worker's own
 * visibility check (public/sw.js) to skip the OS banner specifically when
 * THIS chat is the page on screen — a Renkei tab in front on some other
 * page still gets the banner, since it isn't already showing the reply.
 * Email and WebEx make no sense for a single chat reply the way they do
 * for a run finishing, so unlike the run/share events this is a plain
 * switch (`chatReplyDesktop`) rather than a three-channel triple, and the
 * whole notification — the feed row too — is gated on it: off by default
 * means nothing happens here at all until a person opts in.
 *
 * A click on the banner opens the chat itself (the push's `appPath`), not
 * the notifications page: the reply is read there and nowhere else.
 *
 * That `quiet` check only answers "is the chat page open right now, at
 * the moment the push is DELIVERED" — it says nothing about someone who
 * watched the whole reply stream in live and then navigated away before
 * this function even ran. For that person the notification is pure noise:
 * they already saw it. `wasRecentlyWatchingChat` (@renkei/notifications'
 * presence.ts) answers that instead, off the turn stream route's own
 * heartbeat (chats/[chatId]/turns/[turnId]/stream/route.ts) — a
 * cross-replica-durable "were they connected to this exact chat's stream
 * a moment ago" — and when it says yes, this skips the notification
 * entirely: no feed row, no push, nothing to dismiss for something
 * already seen.
 */

import { randomUUID } from 'node:crypto';
import { getDatabase } from '@renkei/db';
import { getNotificationPrefs } from '@renkei/user-prefs';
import { getOrgSettings } from '@renkei/settings';
import { parseEncryptionKey } from '@renkei/crypto';
import { sendPush, wasRecentlyWatchingChat } from '@renkei/notifications';
import { logger } from '@/lib/logger';

export function notifyChatReplyDesktop(input: {
  tenantId: string;
  /** The chat's owner — the only one who can send it a message. */
  ownerSubject: string;
  chatId: string;
  chatTitle: string | null;
}): void {
  void (async () => {
    // fresh: a person who just turned this on (or off) expects the very
    // next reply to reflect it, not whatever the last minute cached.
    const prefs = await getNotificationPrefs(input.tenantId, input.ownerSubject, { fresh: true });
    if (!prefs.chatReplyDesktop) return;

    const dbResult = getDatabase();
    if (!dbResult.ok) return;

    const settingsResult = await getOrgSettings(input.tenantId);
    const presenceWindowSeconds = settingsResult.ok
      ? settingsResult.val.chatReplyPresenceWindowSeconds
      : 0;
    if (presenceWindowSeconds > 0) {
      const watchedLive = await wasRecentlyWatchingChat(
        dbResult.val,
        input.tenantId,
        input.ownerSubject,
        input.chatId,
        presenceWindowSeconds
      );
      if (watchedLive) return;
    }

    const tenant = await dbResult.val
      .selectFrom('tenants')
      .select('slug')
      .where('id', '=', input.tenantId)
      .executeTakeFirst();
    if (!tenant) return;

    const title = input.chatTitle || 'New chat';
    const headline = `“${title}” has a new reply`;
    const refUrl = `/${tenant.slug}/chat/${input.chatId}`;
    const id = randomUUID();
    await dbResult.val
      .insertInto('agent_notifications')
      .values({
        id,
        tenant_id: input.tenantId,
        subject: input.ownerSubject,
        kind: 'chat_reply',
        headline,
        ref_url: refUrl,
      })
      .execute();

    // Fire-and-forget, same as every other write in this app: a push
    // service's own latency must never add to the turn it describes.
    const keyResult = parseEncryptionKey(process.env.TOKEN_ENCRYPTION_KEY || '');
    if (keyResult.ok) {
      void sendPush(
        dbResult.val,
        input.tenantId,
        input.ownerSubject,
        keyResult.val,
        {
          title: headline,
          body: 'Renkei',
          tag: `chat-reply:${input.chatId}`,
          refUrl,
          notificationId: id,
          // The reply is read in the chat, so the banner opens the chat.
          appPath: refUrl,
          // Already visible in the chat itself — skip the banner only when
          // that exact chat is the page on screen.
          quiet: true,
        },
        { log: (message, meta) => logger.warn(message, meta) }
      );
    }
  })().catch((error: unknown) => {
    logger.warn('chat-reply desktop notification not recorded', {
      component: 'chat/reply-notification',
      tenantId: input.tenantId,
      chatId: input.chatId,
      error: error instanceof Error ? error.message : String(error),
    });
  });
}
