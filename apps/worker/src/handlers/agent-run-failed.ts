/**
 * The agents/run.failed handler — telling the owner their agent broke,
 * over whichever of Outlook/WebEx their own Preferences say they want AND
 * have connected. Each channel is independently gated: `runFailed.email`
 * for the Outlook mail, `runFailed.webex` for the WebEx note-to-self, and a
 * channel that isn't connected is skipped silently either way — the run
 * page shows the failure regardless, so notification is reach, never the
 * record. The delivery itself is owner-channels.ts, shared with the batch
 * job announcements.
 *
 * Deliberately never throws on delivery: a notification retrying through
 * the queue would re-mail the owner every backoff. Only missing
 * prerequisites (db down) throw for redelivery.
 */

import { getDatabase } from '@renkei/db';
import { effectiveDelivery, getNotificationPrefs } from '@renkei/user-prefs';
import type { ClaimedEvent } from '../queue';
import type { EventHandler } from '../handlers';
import { deliverToOwnerChannels } from './owner-channels';
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

/**
 * Human wording for a raw error_kind — the fallback when the run row has no
 * error sentence. Local copy: the worker cannot import apps/web's
 * run-labels, and six literals beat a shared package.
 */
function friendlyErrorKind(errorKind: string): string {
  switch (errorKind) {
    case 'step_failed':
      return 'a step failed';
    case 'config':
      return 'a setup problem';
    case 'timeout':
      return 'it ran out of time';
    case 'llm_auth':
      return 'an AI model sign-in problem';
    case 'llm_error':
      return 'an AI model error';
    case 'llm_rate_limit':
      return 'the AI model was busy';
    case 'guard':
      return 'a safety guard stopped it';
    default:
      return errorKind;
  }
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

    // Cheapest check first: nothing on either channel means no grant
    // lookups, no Graph/WebEx calls — just done. Resolved through the
    // agent's own override when it set one, same as every other run event.
    const prefs = await getNotificationPrefs(tenantId, payload.ownerSubject);
    const wanted = effectiveDelivery(prefs, payload.agentId, 'runFailed');
    if (!wanted.email && !wanted.webex) return;

    const [agent, run, base] = await Promise.all([
      db.selectFrom('agents').select('name').where('id', '=', payload.agentId).executeTakeFirst(),
      db
        .selectFrom('agent_runs')
        .select(['error'])
        .where('id', '=', payload.runId)
        .executeTakeFirst(),
      registrationUrl(tenantId),
    ]);

    const agentName = agent?.name ?? 'Your agent';
    const reason =
      run?.error ??
      (payload.errorKind ? friendlyErrorKind(payload.errorKind) : 'an unknown problem');
    const link = base ? `${base}/agents/${payload.agentId}/runs/${payload.runId}` : null;
    const bodyText = `Your agent “${agentName}” stopped on a failure: ${reason}${link ? `\n\nSee the run: ${link}` : ''}`;

    await deliverToOwnerChannels(db, {
      tenantId,
      ownerSubject: payload.ownerSubject,
      email: wanted.email,
      webex: wanted.webex,
      heading: `Agent “${agentName}” failed`,
      body: bodyText,
      log: { component: 'worker/agent-notify', runId: payload.runId },
    });
  };
}
