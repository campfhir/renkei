/**
 * The interactive pipeline's hooks into agent event triggers — the worker
 * side of the trigger catalog's contract (@renkei/agents trigger-catalog):
 * every event listed there has exactly one emitting call site here, and
 * the payload keys written here are the `trigger.*` variables the catalog
 * promises the builder.
 *
 * Fan-out is best-effort BY DESIGN: an agent misfire must never fail mail
 * sync or a WebEx reply, so every path here logs and swallows. The runs
 * themselves land on the agent_jobs queue and execute in worker-agents.
 */

import { getDatabase } from '@renkei/db';
import { agentJobsQueue } from '@renkei/queue';
import { fanOutAgentEvents } from '@renkei/agents/event-fanout';
import { logger } from '../logger';

const BODY_PREVIEW_CHARS = 1_024;
/**
 * Only mail younger than this fires agents. A delta round replays changed
 * items — a read-status flip on last month's mail arrives just like a new
 * message — and a full mailbox rebuild replays everything; the recency
 * window (with the rebuild skip at the call site) is what keeps "an email
 * arrives" meaning ARRIVES.
 */
const MAIL_RECENCY_MS = 24 * 60 * 60_000;

const queue = agentJobsQueue();

/** The Microsoft grant's owner — whose agents a mailbox event may fire. */
async function subjectForMicrosoftAccount(
  tenantId: string,
  accountId: string
): Promise<string | null> {
  const dbResult = getDatabase();
  if (!dbResult.ok) return null;
  const row = await dbResult.val
    .selectFrom('provider_grants')
    .select('subject')
    .where('tenant_id', '=', tenantId)
    .where('provider', '=', 'microsoft')
    .where('provider_account_id', '=', accountId)
    .executeTakeFirst();
  return row?.subject ?? null;
}

export function isRecentMail(receivedDateTime: string): boolean {
  const received = Date.parse(receivedDateTime);
  return Number.isFinite(received) && Date.now() - received < MAIL_RECENCY_MS;
}

/** microsoft/mail.received — a new message in the owner's own mailbox. */
export async function fanOutMailReceived(params: {
  tenantId: string;
  accountId: string;
  messageId: string;
  subject: string;
  bodyPreview: string;
  from: string;
  receivedDateTime: string;
}): Promise<void> {
  try {
    const ownerSubject = await subjectForMicrosoftAccount(params.tenantId, params.accountId);
    if (!ownerSubject) return;
    const dbResult = getDatabase();
    if (!dbResult.ok) return;
    await fanOutAgentEvents(dbResult.val, queue.producer, {
      tenantId: params.tenantId,
      source: 'microsoft',
      type: 'mail.received',
      ownerSubject,
      payload: {
        subject: params.subject,
        body: params.bodyPreview.slice(0, BODY_PREVIEW_CHARS),
        from: params.from,
        messageId: params.messageId,
      },
    });
  } catch (error) {
    logger.warn('mail.received agent fan-out failed: {error}', {
      component: 'worker/agent-triggers',
      tenantId: params.tenantId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/** webex/message.received — a message from a linked sender. */
export async function fanOutWebexMessage(params: {
  tenantId: string;
  senderEmail: string;
  messageId: string;
  roomId: string;
  text: string;
}): Promise<void> {
  try {
    const dbResult = getDatabase();
    if (!dbResult.ok) return;
    const identity = await dbResult.val
      .selectFrom('identities')
      .select('subject')
      .where('tenant_id', '=', params.tenantId)
      .where('email', '=', params.senderEmail.toLowerCase())
      .executeTakeFirst();
    if (!identity) return;
    await fanOutAgentEvents(dbResult.val, queue.producer, {
      tenantId: params.tenantId,
      source: 'webex',
      type: 'message.received',
      ownerSubject: identity.subject,
      payload: {
        text: params.text.slice(0, BODY_PREVIEW_CHARS),
        sender: params.senderEmail,
        roomId: params.roomId,
        messageId: params.messageId,
      },
    });
  } catch (error) {
    logger.warn('webex message agent fan-out failed: {error}', {
      component: 'worker/agent-triggers',
      tenantId: params.tenantId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
