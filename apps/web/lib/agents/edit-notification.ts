/**
 * The owner's "someone changed your agent" ping — written when a save
 * lands through an access grant (access-grants.ts) rather than from the
 * owner themself.
 *
 * Same write-time preference rule as the worker's notifier: `effectiveDelivery`
 * (the agent's own override when it set one, else the owner's
 * `agentEditedByOthers`, on by default for App) is consulted when the edit
 * happens, and a suppressed channel is never fired retroactively. The audit
 * trail does NOT go through here — an edit by a non-owner is always
 * audited; only this courtesy notification is optional, on any channel.
 *
 * Fire-and-forget like recordAuditEvent: a notification must never fail or
 * slow the save it describes. There is no run-scoped MCP session to lean
 * on here (unlike the agent engine's own notifier), so email and WebEx go
 * out over each provider's direct API, gated on the owner's own grant —
 * same pattern as the worker's run.failed handler.
 */

import { randomUUID } from 'node:crypto';
import { getDatabase } from '@renkei/db';
import { WebexClient } from '@renkei/connector-webex';
import { effectiveDelivery, getNotificationPrefs } from '@renkei/user-prefs';
import { parseEncryptionKey } from '@renkei/crypto';
import { sendPush } from '@renkei/notifications';
import { resolveGraphAccess, graphPost } from '@/lib/mcp-tools/graph/client';
import { resolveWebexUserAccess } from '@/lib/webex-user-access';
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
    const wanted = effectiveDelivery(prefs, input.agentId, 'agentEditedByOthers');
    if (!wanted.app && !wanted.email && !wanted.webex) return;

    const who = await getIdentityDisplay(input.tenantId, input.actorSubject);
    const editorName = who?.displayName || who?.email || 'Someone you shared it with';
    const headline = `${editorName} edited your agent "${input.agentName}"`;

    if (wanted.app) {
      const dbResult = getDatabase();
      if (dbResult.ok) {
        const id = randomUUID();
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
      }
    }

    if (wanted.email) {
      const owner = await getIdentityDisplay(input.tenantId, input.ownerSubject);
      if (owner?.email) {
        const access = await resolveGraphAccess({
          tenantId: input.tenantId,
          subject: input.ownerSubject,
        });
        if (typeof access === 'string') {
          logger.warn('agent-edited mail not sent: {reason}', {
            component: 'agents/edit-notification',
            tenantId: input.tenantId,
            agentId: input.agentId,
            reason: access,
          });
        } else {
          const context = { tenantId: input.tenantId, subject: input.ownerSubject };
          const sent = await graphPost(context, access.accessToken, '/me/sendMail', {
            message: {
              subject: headline,
              body: { contentType: 'Text', content: headline },
              toRecipients: [{ emailAddress: { address: owner.email } }],
            },
            saveToSentItems: false,
          });
          if (!sent.ok) {
            logger.warn('agent-edited mail not sent: {reason}', {
              component: 'agents/edit-notification',
              tenantId: input.tenantId,
              agentId: input.agentId,
              reason: sent.error,
            });
          }
        }
      }
    }

    if (wanted.webex) {
      const access = await resolveWebexUserAccess(input.tenantId, input.ownerSubject);
      if (access) {
        const client = new WebexClient(access.accessToken);
        const sent = await client.sendNoteToSelf(`**${headline}**`);
        if (!sent.ok) {
          logger.warn('agent-edited WebEx note not sent for agent {agentId}', {
            component: 'agents/edit-notification',
            tenantId: input.tenantId,
            agentId: input.agentId,
          });
        }
      }
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
