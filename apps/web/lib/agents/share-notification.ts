/**
 * The "someone shared an agent with you" ping — written when a grant lands
 * through the agent's own access route. `edit-notification.ts`'s sibling:
 * same write-time preference rule (read fresh, a suppressed channel never
 * fires retroactively) and the same fire-and-forget posture.
 */

import { randomUUID } from 'node:crypto';
import { getDatabase } from '@renkei/db';
import { WebexClient } from '@renkei/connector-webex';
import { getNotificationPrefs } from '@renkei/user-prefs';
import { parseEncryptionKey } from '@renkei/crypto';
import { sendPush } from '@renkei/notifications';
import { resolveGraphAccess, graphPost } from '@/lib/mcp-tools/graph/client';
import { resolveWebexUserAccess } from '@/lib/webex-user-access';
import { getIdentityDisplay } from '@/lib/identity';
import { logger } from '@/lib/logger';

export function notifyAgentShared(input: {
  tenantId: string;
  /** Who now has access — the notification's reader. */
  granteeSubject: string;
  /** Who shared it. */
  actorSubject: string;
  agentId: string;
  agentName: string;
}): void {
  void (async () => {
    const prefs = await getNotificationPrefs(input.tenantId, input.granteeSubject, { fresh: true });
    const wanted = prefs.agentShared;
    if (!wanted.app && !wanted.email && !wanted.webex) return;

    const who = await getIdentityDisplay(input.tenantId, input.actorSubject);
    const sharerName = who?.displayName || who?.email || 'Someone';
    const headline = `${sharerName} shared the agent "${input.agentName}" with you`;

    if (wanted.app) {
      const dbResult = getDatabase();
      if (dbResult.ok) {
        const id = randomUUID();
        await dbResult.val
          .insertInto('agent_notifications')
          .values({
            id,
            tenant_id: input.tenantId,
            subject: input.granteeSubject,
            kind: 'agent_shared',
            headline,
            agent_id: input.agentId,
            agent_name: input.agentName,
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
            { title: headline, body: input.agentName, tag: id, refUrl: null },
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
          logger.warn('agent-shared mail not sent: {reason}', {
            component: 'agents/share-notification',
            tenantId: input.tenantId,
            agentId: input.agentId,
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
            logger.warn('agent-shared mail not sent: {reason}', {
              component: 'agents/share-notification',
              tenantId: input.tenantId,
              agentId: input.agentId,
              reason: sent.error,
            });
          }
        }
      }
    }

    if (wanted.webex) {
      const access = await resolveWebexUserAccess(input.tenantId, input.granteeSubject);
      if (access) {
        const client = new WebexClient(access.accessToken);
        const sent = await client.sendNoteToSelf(`**${headline}**`);
        if (!sent.ok) {
          logger.warn('agent-shared WebEx note not sent for agent {agentId}', {
            component: 'agents/share-notification',
            tenantId: input.tenantId,
            agentId: input.agentId,
          });
        }
      }
    }
  })().catch((error: unknown) => {
    logger.warn('agent-shared notification not recorded', {
      component: 'agents/share-notification',
      tenantId: input.tenantId,
      agentId: input.agentId,
      error: error instanceof Error ? error.message : String(error),
    });
  });
}
