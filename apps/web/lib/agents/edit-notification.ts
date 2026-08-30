/**
 * The owner's "someone changed your agent" ping — written when a save
 * lands through an access grant (access-grants.ts) rather than from the
 * owner themself.
 *
 * Same write-time preference rule as the worker's notifier: the owner's
 * `agentEditedByOthers` switch (on by default) is consulted when the edit
 * happens, and a suppressed ping is never written retroactively. The audit
 * trail does NOT go through here — an edit by a non-owner is always
 * audited; only this courtesy row is optional.
 *
 * Fire-and-forget like recordAuditEvent: a notification must never fail or
 * slow the save it describes.
 */

import { randomUUID } from 'node:crypto';
import { getDatabase } from '@renkei/db';
import { getNotificationPrefs } from '@renkei/user-prefs';
import { parseEncryptionKey } from '@renkei/crypto';
import { sendPush } from '@renkei/notifications';
import { getIdentityDisplay } from '@/lib/identity';
import { logger } from '@/lib/logger';

export function notifyAgentEdited(input: {
  tenantId: string;
  /** Whose agent it is — the notification's reader. */
  ownerSubject: string;
  /** Who saved the change. */
  actorSubject: string;
  agentId: string;
  agentName: string;
}): void {
  void (async () => {
    // fresh: the preferences page saves through a different module graph,
    // and "I just turned this off" must hold for the very next edit.
    const prefs = await getNotificationPrefs(input.tenantId, input.ownerSubject, { fresh: true });
    if (!prefs.agentEditedByOthers) return;

    const dbResult = getDatabase();
    if (!dbResult.ok) return;

    const who = await getIdentityDisplay(input.tenantId, input.actorSubject);
    const editorName = who?.displayName || who?.email || 'Someone you shared it with';
    const id = randomUUID();
    const headline = `${editorName} edited your agent "${input.agentName}"`;

    await dbResult.val
      .insertInto('agent_notifications')
      .values({
        id,
        tenant_id: input.tenantId,
        subject: input.ownerSubject,
        kind: 'agent_edited',
        headline,
        agent_id: input.agentId,
        agent_name: input.agentName,
      })
      .execute();

    // Fire-and-forget, same as the row above it: see notifications.ts's
    // write() (the worker's twin of this function) for why.
    const keyResult = parseEncryptionKey(process.env.TOKEN_ENCRYPTION_KEY || '');
    if (keyResult.ok) {
      void sendPush(
        dbResult.val,
        input.tenantId,
        input.ownerSubject,
        keyResult.val,
        { title: headline, body: input.agentName, tag: id, refUrl: null },
        { log: (message, meta) => logger.warn(message, meta) }
      );
    }
  })().catch((error: unknown) => {
    logger.warn('agent-edited notification not recorded', {
      component: 'agents/edit-notification',
      tenantId: input.tenantId,
      agentId: input.agentId,
      error: error instanceof Error ? error.message : String(error),
    });
  });
}
