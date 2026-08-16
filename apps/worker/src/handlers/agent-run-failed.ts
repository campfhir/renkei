/**
 * The agents/run.failed handler — telling the owner their agent broke,
 * over BOTH channels they have connected: an email (sent from their own
 * Outlook grant, to their own address) and a WebEx DM from the org bot.
 * Each channel is skipped silently when unconnected; the run page shows
 * the failure regardless, so notification is reach, never the record.
 *
 * Deliberately never throws on delivery: a notification retrying through
 * the queue would re-mail the owner every backoff. Only missing
 * prerequisites (db down) throw for redelivery.
 */

import { getDatabase } from '@renkei/db';
import { graphRequest } from '@renkei/connector-microsoft';
import type { ClaimedEvent } from '../queue';
import type { EventHandler } from '../handlers';
import { resolveMicrosoftAccess } from './microsoft-access';
import { resolveWebexContext } from './webex-context';
import { registrationUrl } from './feed-url';
import { logger } from '../logger';

interface FailedPayload {
  runId: string;
  agentId: string;
  ownerSubject: string;
  errorKind: string | null;
}

function parsePayload(event: ClaimedEvent): FailedPayload | null {
  const payload: unknown = event.payload;
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return null;
  const record: {
    runId?: unknown;
    agentId?: unknown;
    ownerSubject?: unknown;
    errorKind?: unknown;
  } = payload;
  if (typeof record.runId !== 'string' || typeof record.agentId !== 'string') return null;
  if (typeof record.ownerSubject !== 'string') return null;
  return {
    runId: record.runId,
    agentId: record.agentId,
    ownerSubject: record.ownerSubject,
    errorKind: typeof record.errorKind === 'string' ? record.errorKind : null,
  };
}

export function createAgentRunFailedHandler(): EventHandler {
  return async (event) => {
    const payload = parsePayload(event);
    if (!payload) {
      logger.warn('run.failed event with malformed payload; dropping', {
        component: 'worker/agent-notify',
      });
      return;
    }
    const tenantId = event.tenant_id;

    const dbResult = getDatabase();
    if (!dbResult.ok) throw new Error('database unavailable');
    const db = dbResult.val;

    const [agent, run, identity, base] = await Promise.all([
      db.selectFrom('agents').select('name').where('id', '=', payload.agentId).executeTakeFirst(),
      db
        .selectFrom('agent_runs')
        .select(['error'])
        .where('id', '=', payload.runId)
        .executeTakeFirst(),
      db
        .selectFrom('identities')
        .select(['email'])
        .where('tenant_id', '=', tenantId)
        .where('subject', '=', payload.ownerSubject)
        .executeTakeFirst(),
      registrationUrl(tenantId),
    ]);
    if (!identity?.email) {
      // No recorded email = nowhere to deliver; the run page still shows it.
      return;
    }

    const agentName = agent?.name ?? 'Your agent';
    const reason = run?.error ?? payload.errorKind ?? 'an unknown problem';
    const link = base ? `${base}/agents/${payload.agentId}/runs/${payload.runId}` : null;
    const bodyText = `Your agent “${agentName}” stopped on a failure: ${reason}${link ? `\n\nSee the run: ${link}` : ''}`;

    // Channel 1: email from the owner's own Outlook grant, to themselves.
    try {
      const grant = await db
        .selectFrom('provider_grants')
        .select('provider_account_id')
        .where('tenant_id', '=', tenantId)
        .where('provider', '=', 'microsoft')
        .where('subject', '=', payload.ownerSubject)
        .executeTakeFirst();
      if (grant) {
        const access = await resolveMicrosoftAccess(tenantId, grant.provider_account_id);
        const sent = await graphRequest(access.accessToken, '/me/sendMail', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            message: {
              subject: `Agent “${agentName}” failed`,
              body: { contentType: 'Text', content: bodyText },
              toRecipients: [{ emailAddress: { address: identity.email } }],
            },
            saveToSentItems: false,
          }),
        });
        if (!sent.ok) {
          logger.warn('failure mail not sent for run {runId}', {
            component: 'worker/agent-notify',
            runId: payload.runId,
          });
        }
      }
    } catch (error) {
      logger.warn('failure mail errored for run {runId}: {error}', {
        component: 'worker/agent-notify',
        runId: payload.runId,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    // Channel 2: WebEx DM from the org bot.
    try {
      const context = await resolveWebexContext(tenantId);
      const posted = await context.client.postMessage({
        toPersonEmail: identity.email,
        markdown: `Your agent **${agentName}** stopped on a failure: ${reason}${link ? `\n\n[See the run](${link})` : ''}`,
      });
      if (!posted.ok) {
        logger.debug('failure DM not delivered for run {runId}', {
          component: 'worker/agent-notify',
          runId: payload.runId,
        });
      }
    } catch (error) {
      // No WebEx configured is the common, silent case.
      logger.debug('failure DM skipped for run {runId}: {error}', {
        component: 'worker/agent-notify',
        runId: payload.runId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };
}
