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
import { getDataStore } from '@renkei/db';
import { effectiveDelivery, getNotificationPrefs } from '@renkei/user-prefs';
import { loadKeyring } from '@renkei/crypto';
import { sendPush } from '@renkei/notifications';
import { resolveGraphAccess, graphPost } from '@/lib/mcp-tools/graph/client';
import { resolveWebexUserAccess } from '@/lib/webex-user-access';
import { sendWebexNote } from '@/lib/webex-note';
import { getIdentityDisplay } from '@/lib/identity';
import { logger } from '@/lib/logger';
import { whoIs, whichAgentOf } from '@/lib/log-actor';

export function notifyAgentEdited(input: {
  /** Whose agent it is — the notification's reader. */
  ownerSubject: string;
  /** Who saved the change. */
  actorSubject: string;
  agentId: string;
  agentName: string;
}): void {
  // The editor as {actor}, the agent with its {owner}: who the line is about.
  const about = async () => ({
    component: 'agents/edit-notification',
    ...(await whoIs(input.actorSubject)),
    ...(await whichAgentOf({
      agentId: input.agentId,
      agentName: input.agentName,
      ownerSubject: input.ownerSubject,
    })),
  });
  void (async () => {
    // fresh: the preferences page saves through a different module graph,
    // and "I just turned this off" must hold for the very next edit.
    const prefs = await getNotificationPrefs(input.ownerSubject, { fresh: true });
    const wanted = effectiveDelivery(prefs, input.agentId, 'agentEditedByOthers');
    if (!wanted.app && !wanted.email && !wanted.webex) return;
    const fields = await about();

    const who = await getIdentityDisplay(input.actorSubject);
    const editorName = who?.displayName || who?.email || 'Someone you shared it with';
    const headline = `${editorName} edited your agent "${input.agentName}"`;

    if (wanted.app) {
      const id = randomUUID();
      await getDataStore().notifications.insert({
        id,
        subject: input.ownerSubject,
        kind: 'agent_edited',
        category: null,
        connector: null,
        tool: null,
        entity: null,
        headline,
        refUrl: null,
        agentId: input.agentId,
        agentName: input.agentName,
        runId: null,
        meta: null,
      });

      // Fire-and-forget, same as the row above it.
      const keyResult = loadKeyring('TOKEN_ENCRYPTION_KEY');
      if (keyResult.ok) {
        void sendPush(
          input.ownerSubject,
          keyResult.val,
          { title: headline, body: input.agentName, tag: id, refUrl: null, notificationId: id },
          { log: (message, meta) => logger.warn(message, { ...fields, ...meta }) }
        );
      }
    }

    if (wanted.email) {
      const owner = await getIdentityDisplay(input.ownerSubject);
      if (owner?.email) {
        const access = await resolveGraphAccess({
          subject: input.ownerSubject,
        });
        if (typeof access === 'string') {
          logger.warn(
            '{actor} edited agent "{agent}", but its owner {owner} was not emailed about it ({reason}); the mail was not sent',
            { ...fields, reason: access }
          );
        } else {
          const context = { subject: input.ownerSubject };
          const sent = await graphPost(context, access.auth, '/me/sendMail', {
            message: {
              subject: headline,
              body: { contentType: 'Text', content: headline },
              toRecipients: [{ emailAddress: { address: owner.email } }],
            },
            saveToSentItems: false,
          });
          if (!sent.ok) {
            logger.warn(
              '{actor} edited agent "{agent}", but the mail telling its owner {owner} was not sent: {reason}',
              { ...fields, reason: sent.error }
            );
          }
        }
      }
    }

    if (wanted.webex) {
      const access = await resolveWebexUserAccess(input.ownerSubject);
      if (access) {
        const sent = await sendWebexNote(access, `**${headline}**`);
        if (!sent.ok) {
          logger.warn(
            '{actor} edited agent "{agent}", but the WebEx note telling its owner {owner} was not sent',
            fields
          );
        }
      }
    }
  })().catch(async (error: unknown) => {
    logger.warn(
      '{actor} edited agent "{agent}", but its owner {owner} was not notified of it: {error}',
      {
        ...(await about()),
        error: error instanceof Error ? error.message : String(error),
      }
    );
  });
}
