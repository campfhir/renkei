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
import { getDatabase } from '@renkei/db';
import { getNotificationPrefs } from '@renkei/user-prefs';
import { parseEncryptionKey } from '@renkei/crypto';
import { sendPush } from '@renkei/notifications';
import { resolveGraphAccess, graphPost } from '@/lib/mcp-tools/graph/client';
import { resolveWebexUserAccess } from '@/lib/webex-user-access';
import { sendWebexNote } from '@/lib/webex-note';
import { getIdentityDisplay } from '@/lib/identity';
import { logger } from '@/lib/logger';

export function notifyChatShared(input: {
  tenantId: string;
  /** Who now has access — the notification's reader. */
  granteeSubject: string;
  /** Who shared it. */
  actorSubject: string;
  chatId: string;
  chatTitle: string | null;
}): void {
  void (async () => {
    const prefs = await getNotificationPrefs(input.tenantId, input.granteeSubject, { fresh: true });
    const wanted = prefs.chatShared;
    if (!wanted.app && !wanted.email && !wanted.webex) return;

    const who = await getIdentityDisplay(input.tenantId, input.actorSubject);
    const sharerName = who?.displayName || who?.email || 'Someone';
    const title = input.chatTitle || 'a chat';
    const headline = `${sharerName} shared "${title}" with you`;

    if (wanted.app) {
      const dbResult = getDatabase();
      if (dbResult.ok) {
        const tenant = await dbResult.val
          .selectFrom('tenants')
          .select('slug')
          .where('id', '=', input.tenantId)
          .executeTakeFirst();
        const refUrl = tenant ? `/${tenant.slug}/chat/${input.chatId}` : null;
        const id = randomUUID();
        await dbResult.val
          .insertInto('agent_notifications')
          .values({
            id,
            tenant_id: input.tenantId,
            subject: input.granteeSubject,
            kind: 'chat_shared',
            headline,
            ref_url: refUrl,
          })
          .execute();

        // Fire-and-forget, same as edit-notification.ts's row.
        const keyResult = parseEncryptionKey(process.env.TOKEN_ENCRYPTION_KEY || '');
        if (keyResult.ok) {
          void sendPush(
            dbResult.val,
            input.tenantId,
            input.granteeSubject,
            keyResult.val,
            { title: headline, body: title, tag: id, refUrl },
            { log: (message, meta) => logger.warn(message, meta) }
          );
        }
      }
    }

    if (wanted.email) {
      const grantee = await getIdentityDisplay(input.tenantId, input.granteeSubject);
      if (grantee?.email) {
        const access = await resolveGraphAccess({
          tenantId: input.tenantId,
          subject: input.granteeSubject,
        });
        if (typeof access === 'string') {
          logger.warn('chat-shared mail not sent: {reason}', {
            component: 'chat/share-notification',
            tenantId: input.tenantId,
            chatId: input.chatId,
            reason: access,
          });
        } else {
          const context = { tenantId: input.tenantId, subject: input.granteeSubject };
          const sent = await graphPost(context, access.accessToken, '/me/sendMail', {
            message: {
              subject: headline,
              body: { contentType: 'Text', content: headline },
              toRecipients: [{ emailAddress: { address: grantee.email } }],
            },
            saveToSentItems: false,
          });
          if (!sent.ok) {
            logger.warn('chat-shared mail not sent: {reason}', {
              component: 'chat/share-notification',
              tenantId: input.tenantId,
              chatId: input.chatId,
              reason: sent.error,
            });
          }
        }
      }
    }

    if (wanted.webex) {
      const access = await resolveWebexUserAccess(input.tenantId, input.granteeSubject);
      if (access) {
        const sent = await sendWebexNote(input.tenantId, access, `**${headline}**`);
        if (!sent.ok) {
          logger.warn('chat-shared WebEx note not sent for chat {chatId}', {
            component: 'chat/share-notification',
            tenantId: input.tenantId,
            chatId: input.chatId,
          });
        }
      }
    }
  })().catch((error: unknown) => {
    logger.warn('chat-shared notification not recorded', {
      component: 'chat/share-notification',
      tenantId: input.tenantId,
      chatId: input.chatId,
      error: error instanceof Error ? error.message : String(error),
    });
  });
}
