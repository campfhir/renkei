/**
 * The "a chat is waiting for your permission" ping. Not optional, and not
 * gated on a preference: like an agent's approval card, the turn is
 * physically parked behind the answer, so the row always lands and the
 * push always goes out. `quiet: true` has the service worker skip the OS
 * banner specifically when this chat is the page on screen, where the
 * pop-up pile and the chat itself already show the ask — a Renkei tab in
 * front on some other page still gets the banner. A click on the banner
 * opens the chat, not the notifications page — the ask is answered there
 * and nowhere else.
 *
 * The row is keyed by the tool call (`ref_id` = the tool_use id) so the
 * decision route can mark it read the moment the person answers, from
 * whichever surface they answered on.
 */

import { randomUUID } from 'node:crypto';
import { getDatabase } from '@renkei/db';
import { parseEncryptionKey } from '@renkei/crypto';
import { sendPush } from '@renkei/notifications';
import { friendlyToolName } from '@renkei/agents';
import { logger } from '@/lib/logger';

export const CHAT_PERMISSION_NOTIFICATION_KIND = 'chat_permission';

export function notifyChatToolPermission(input: {
  tenantId: string;
  /** The chat's owner — the only one who can answer. */
  ownerSubject: string;
  chatId: string;
  chatTitle: string | null;
  toolUseId: string;
  toolName: string;
}): void {
  void (async () => {
    const dbResult = getDatabase();
    if (!dbResult.ok) return;

    const tenant = await dbResult.val
      .selectFrom('tenants')
      .select('slug')
      .where('id', '=', input.tenantId)
      .executeTakeFirst();
    if (!tenant) return;

    const title = input.chatTitle || 'New chat';
    const headline = `“${title}” is waiting for your permission to ${friendlyToolName(
      input.toolName,
      null
    ).toLowerCase()}`;
    const refUrl = `/${tenant.slug}/chat/${input.chatId}`;
    const id = randomUUID();
    await dbResult.val
      .insertInto('agent_notifications')
      .values({
        id,
        tenant_id: input.tenantId,
        subject: input.ownerSubject,
        kind: CHAT_PERMISSION_NOTIFICATION_KIND,
        tool: input.toolName,
        headline,
        ref_id: input.toolUseId,
        ref_url: refUrl,
      })
      .execute();

    // Fire-and-forget: a push service's latency never adds to the wait.
    const keyResult = parseEncryptionKey(process.env.TOKEN_ENCRYPTION_KEY || '');
    if (keyResult.ok) {
      void sendPush(
        dbResult.val,
        input.tenantId,
        input.ownerSubject,
        keyResult.val,
        {
          title: headline,
          body: 'Allow or deny it in the chat',
          tag: `chat-permission:${input.chatId}`,
          refUrl,
          notificationId: id,
          appPath: refUrl,
          // Already visible in the chat itself — skip the banner only when
          // that exact chat is the page on screen.
          quiet: true,
        },
        { log: (message, meta) => logger.warn(message, meta) }
      );
    }
  })().catch((error: unknown) => {
    logger.warn('chat permission notification not recorded', {
      component: 'chat/permission-notification',
      tenantId: input.tenantId,
      chatId: input.chatId,
      error: error instanceof Error ? error.message : String(error),
    });
  });
}

/**
 * The ask was answered: its row is read, wherever the answer came from.
 * Best-effort, like every notification write — a row left unread costs a
 * badge count, never the decision.
 */
export async function markChatToolPermissionRead(
  tenantId: string,
  subject: string,
  toolUseId: string
): Promise<void> {
  const dbResult = getDatabase();
  if (!dbResult.ok) return;
  try {
    await dbResult.val
      .updateTable('agent_notifications')
      .set({ read_at: new Date() })
      .where('tenant_id', '=', tenantId)
      .where('subject', '=', subject)
      .where('kind', '=', CHAT_PERMISSION_NOTIFICATION_KIND)
      .where('ref_id', '=', toolUseId)
      .where('read_at', 'is', null)
      .execute();
  } catch (error) {
    logger.warn('chat permission notification not marked read', {
      component: 'chat/permission-notification',
      tenantId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
