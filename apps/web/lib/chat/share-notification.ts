/**
 * The "someone shared a chat with you" ping — written when a grant lands
 * through the chat's own share route (share-modal.tsx → the grants API).
 *
 * Same write-time preference rule as `edit-notification.ts`'s twin: read
 * fresh (the preferences page saves through a different module graph),
 * and a suppressed channel never fires retroactively. Fire-and-forget —
 * a notification must never fail or slow the share it describes.
 */

import { randomUUID } from 'node:crypto';
import { getDataStore } from '@renkei/db';
import { getNotificationPrefs } from '@renkei/user-prefs';
import { loadKeyring } from '@renkei/crypto';
import { sendPush } from '@renkei/notifications';
import { resolveGraphAccess, graphPost } from '@/lib/mcp-tools/graph/client';
import { resolveWebexUserAccess } from '@/lib/webex-user-access';
import { sendWebexNote } from '@/lib/webex-note';
import { getIdentityDisplay } from '@/lib/identity';
import { logger } from '@/lib/logger';
import { whoIs } from '@/lib/log-actor';

export function notifyChatShared(input: {
  /** Who now has access — the notification's reader. */
  granteeSubject: string;
  /** Who shared it. */
  actorSubject: string;
  chatId: string;
  chatTitle: string | null;
}): void {
  // The sharer as {actor} and the person it was shared with as {grantee}.
  const about = async () => {
    const grantee = await whoIs(input.granteeSubject);
    return {
      component: 'chat/share-notification',
      ...(await whoIs(input.actorSubject)),
      grantee: grantee.actor,
      granteeSubject: grantee.subject,
      granteeEmail: grantee.email,
      chatId: input.chatId,
      chat: input.chatTitle ? `the chat "${input.chatTitle}"` : 'an untitled chat',
    };
  };
  void (async () => {
    const prefs = await getNotificationPrefs(input.granteeSubject, { fresh: true });
    const wanted = prefs.chatShared;
    if (!wanted.app && !wanted.email && !wanted.webex) return;
    const fields = await about();

    const who = await getIdentityDisplay(input.actorSubject);
    const sharerName = who?.displayName || who?.email || 'Someone';
    const title = input.chatTitle || 'a chat';
    const headline = `${sharerName} shared "${title}" with you`;

    if (wanted.app) {
      const refUrl = `/chat/${input.chatId}`;
      const id = randomUUID();
      await getDataStore().notifications.insert({
        id,
        subject: input.granteeSubject,
        kind: 'chat_shared',
        category: null,
        connector: null,
        tool: null,
        entity: null,
        headline,
        refUrl,
        agentId: null,
        agentName: null,
        runId: null,
        meta: null,
      });

      // Fire-and-forget, same as edit-notification.ts's row.
      const keyResult = loadKeyring('TOKEN_ENCRYPTION_KEY');
      if (keyResult.ok) {
        void sendPush(
          input.granteeSubject,
          keyResult.val,
          {
            title: headline,
            body: title,
            tag: id,
            refUrl,
            notificationId: id,
            ...(refUrl ? { appPath: refUrl } : {}),
          },
          { log: (message, meta) => logger.warn(message, { ...fields, ...meta }) }
        );
      }
    }

    if (wanted.email) {
      const grantee = await getIdentityDisplay(input.granteeSubject);
      if (grantee?.email) {
        const access = await resolveGraphAccess({
          subject: input.granteeSubject,
        });
        if (typeof access === 'string') {
          logger.warn(
            '{actor} shared {chat} with {grantee}, but the mail telling them was not sent ({reason})',
            { ...fields, reason: access }
          );
        } else {
          const context = { subject: input.granteeSubject };
          const sent = await graphPost(context, access.auth, '/me/sendMail', {
            message: {
              subject: headline,
              body: { contentType: 'Text', content: headline },
              toRecipients: [{ emailAddress: { address: grantee.email } }],
            },
            saveToSentItems: false,
          });
          if (!sent.ok) {
            logger.warn(
              '{actor} shared {chat} with {grantee}, but the mail telling them was not sent: {reason}',
              { ...fields, reason: sent.error }
            );
          }
        }
      }
    }

    if (wanted.webex) {
      const access = await resolveWebexUserAccess(input.granteeSubject);
      if (access) {
        const sent = await sendWebexNote(access, `**${headline}**`);
        if (!sent.ok) {
          logger.warn(
            '{actor} shared {chat} with {grantee}, but the WebEx note telling them was not sent',
            fields
          );
        }
      }
    }
  })().catch(async (error: unknown) => {
    logger.warn('{actor} shared {chat} with {grantee}, but they were not notified: {error}', {
      ...(await about()),
      error: error instanceof Error ? error.message : String(error),
    });
  });
}
