/**
 * The human half of a paused run: reading the approvals waiting on someone,
 * and deciding one.
 *
 * An approval node parks its run as 'waiting' and puts a card on the
 * owner's feed. Until now the only way to answer that card was the web
 * feed's buttons — the decision route owned both the claim semantics and
 * the wake, so nothing else could offer the same thing without copying
 * them. An agent that pauses for a person is not much use to someone
 * working through a chat client that cannot answer it.
 *
 * So the semantics live here, once, and the route and the MCP tools are
 * both callers:
 *
 *  - The card's optimistic `suggested → approved|declined` claim is the
 *    SINGLE arbiter. The engine and the timeout sweep race through the same
 *    UPDATE, and the loser of a concurrent decision is told so rather than
 *    silently overwriting a decision that already stands.
 *  - Run-status transitions belong to the ENGINE alone. A decision claims
 *    the card and enqueues {runId}; the worker reads the card and routes
 *    the outcome path.
 *  - A failed enqueue does NOT roll the decision back. The claim is
 *    durable, and the approval sweep's decided-but-stuck arm resumes the
 *    run within minutes — so the honest answer is "decided, resuming
 *    shortly", never "it did not happen".
 */

import { sql, type Kysely } from 'kysely';
import type { DB } from '@renkei/db';
import type { QueueProducer } from '@renkei/queue';
import {
  MAX_APPROVAL_ANSWER_CHARS,
  checkApprovalAnswers,
  parseApprovalFields,
  type ApprovalAnswerIssue,
  type ApprovalAnswerValue,
  type ApprovalField,
} from '@renkei/agents';

/**
 * Re-exported so the route and the MCP tools keep importing the cap from
 * the module that enforces it; the value itself belongs with the checking
 * rules in @renkei/agents, which the card also runs client-side.
 */
export { MAX_APPROVAL_ANSWER_CHARS };

export type ApprovalMode = 'approve' | 'input';

export interface PendingApproval {
  /** The card id — what a decision names. */
  cardId: string;
  runId: string;
  agentId: string;
  agentName: string;
  /** The card headline, e.g. "Refund triage — needs your approval". */
  title: string;
  /** The step's rendered message: what is actually being asked. */
  message: string;
  /** 'approve' wants a verdict; 'input' wants a typed answer with it. */
  mode: ApprovalMode;
  /**
   * The form the card is asking with, as the engine snapshotted it. Empty
   * for an approve card, and for an input card that asks with one plain
   * box — which is every input card saved before forms existed.
   */
  fields: ApprovalField[];
  raisedAt: string;
  /**
   * When the wait runs out and the run takes its timed-out path. Null only
   * for a card whose run has since stopped waiting.
   */
  waitingUntil: string | null;
}

/** The mode the engine recorded on the card, defaulting to a verdict. */
function modeOf(suggestedAction: unknown): ApprovalMode {
  if (typeof suggestedAction !== 'object' || suggestedAction === null) return 'approve';
  const action: { approvalMode?: unknown } = suggestedAction;
  return action.approvalMode === 'input' ? 'input' : 'approve';
}

/** The form the engine snapshotted onto the card, or [] for a plain one. */
function fieldsOf(suggestedAction: unknown): ApprovalField[] {
  if (typeof suggestedAction !== 'object' || suggestedAction === null) return [];
  const action: { fields?: unknown } = suggestedAction;
  return parseApprovalFields(action.fields);
}

/**
 * The approvals waiting on this person, oldest first — the one that has
 * been waiting longest is the one about to time out.
 *
 * Owner-scoped by construction: the engine writes `owner_subject` = the
 * run's owner, so someone else's approval is not in this list and is not
 * decidable through `decideApproval` either.
 */
export async function listPendingApprovals(
  db: Kysely<DB>,
  tenantId: string,
  subject: string,
  options: { agentId?: string | undefined; limit?: number | undefined } = {}
): Promise<PendingApproval[]> {
  let query = db
    .selectFrom('actionable_items as c')
    .innerJoin('agents as a', 'a.id', 'c.created_by_agent_id')
    .leftJoin('agent_runs as r', 'r.id', 'c.run_id')
    .select([
      'c.id as cardId',
      'c.run_id as runId',
      'c.title as title',
      'c.summary as summary',
      'c.suggested_action as suggestedAction',
      'c.created_at as createdAt',
      'a.id as agentId',
      'a.name as agentName',
      'r.waiting_until as waitingUntil',
    ])
    .where('c.tenant_id', '=', tenantId)
    .where('c.owner_subject', '=', subject)
    .where('c.kind', '=', 'approval')
    // 'suggested' is the only undecided state; the sweep expires the rest.
    .where('c.status', '=', 'suggested')
    .where('c.archived_at', 'is', null)
    .orderBy('c.created_at', 'asc')
    .limit(Math.min(Math.max(options.limit ?? 20, 1), 50));
  if (options.agentId) query = query.where('a.id', '=', options.agentId);

  const rows = await query.execute();
  return rows.flatMap((row) =>
    row.runId
      ? [
          {
            cardId: row.cardId,
            runId: row.runId,
            agentId: row.agentId,
            agentName: row.agentName,
            title: row.title,
            message: row.summary ?? '',
            mode: modeOf(row.suggestedAction),
            fields: fieldsOf(row.suggestedAction),
            raisedAt: new Date(row.createdAt).toISOString(),
            waitingUntil: row.waitingUntil ? new Date(row.waitingUntil).toISOString() : null,
          },
        ]
      : []
  );
}

export type ApprovalDecision = 'approve' | 'decline';

export type DecideApprovalResult =
  | { outcome: 'not-found' }
  | { outcome: 'not-approval' }
  | { outcome: 'already-decided'; status: string }
  | { outcome: 'answer-too-long'; max: number }
  /** A form card whose answers do not fit the form that asked. */
  | { outcome: 'invalid-answers'; issues: ApprovalAnswerIssue[] }
  /** The claim won. `resumed` false means the sweep will wake the run. */
  | { outcome: 'decided'; decision: ApprovalDecision; runId: string; resumed: boolean };

/**
 * Decide one approval card and wake its run.
 *
 * The producer is a parameter rather than an import so this stays testable
 * and so the queue is the caller's concern — the same shape `createAgentRun`
 * uses.
 */
export async function decideApproval(
  db: Kysely<DB>,
  producer: QueueProducer,
  tenantId: string,
  subject: string,
  input: {
    cardId: string;
    decision: ApprovalDecision;
    answer?: string | undefined;
    /** A form card's answers: one entry per field, keyed by field name. */
    answers?: unknown;
  }
): Promise<DecideApprovalResult> {
  const answer = typeof input.answer === 'string' ? input.answer.trim() : '';
  if (answer.length > MAX_APPROVAL_ANSWER_CHARS) {
    return { outcome: 'answer-too-long', max: MAX_APPROVAL_ANSWER_CHARS };
  }

  // Owner-scoped: someone else's card reads as not-found, never as
  // forbidden — the same rule every agents read follows.
  const item = await db
    .selectFrom('actionable_items')
    .select(['id', 'kind', 'status', 'run_id', 'suggested_action'])
    .where('id', '=', input.cardId)
    .where('tenant_id', '=', tenantId)
    .where('owner_subject', '=', subject)
    .executeTakeFirst();
  if (!item) return { outcome: 'not-found' };
  if (item.kind !== 'approval' || !item.run_id) return { outcome: 'not-approval' };
  if (item.status !== 'suggested') return { outcome: 'already-decided', status: item.status };

  /*
    A form's answers are checked HERE, against the spec the card was raised
    with, because this is the last place both are in hand: the browser's
    copy of the form can be stale, and an MCP caller never saw one. The
    rules themselves live in @renkei/agents so the card can run the same
    ones as you type.

    Only on the approve path — declining is "I have no answer", and
    demanding a well-formed one to say so would be a trap.
  */
  const fields = fieldsOf(item.suggested_action);
  let answers: Record<string, ApprovalAnswerValue> | null = null;
  if (fields.length > 0 && input.decision === 'approve') {
    const checked = checkApprovalAnswers(fields, input.answers);
    if (!checked.ok) return { outcome: 'invalid-answers', issues: checked.issues };
    answers = checked.values;
  }

  // The optimistic claim: exactly one decider wins; decided beats expired.
  const claimed = await db
    .updateTable('actionable_items')
    .set({
      status: input.decision === 'approve' ? 'approved' : 'declined',
      result: JSON.stringify({
        ...(answer ? { answer } : {}),
        ...(answers ? { answers } : {}),
        decidedBy: subject,
      }),
      decided_by: subject,
      decided_at: sql`NOW()`,
      archived_at: sql`NOW()`,
      archived_by: subject,
      updated_at: sql`NOW()`,
    })
    .where('id', '=', input.cardId)
    .where('status', '=', 'suggested')
    .executeTakeFirst();
  if (Number(claimed.numUpdatedRows ?? 0) === 0) {
    return { outcome: 'already-decided', status: 'decided' };
  }

  // Wake the run. The ordering key serializes with the agent's other jobs —
  // the same key every enqueue of this run uses.
  const run = await db
    .selectFrom('agent_runs')
    .select(['id', 'agent_id'])
    .where('id', '=', item.run_id)
    .where('tenant_id', '=', tenantId)
    .executeTakeFirst();
  const enqueue = run
    ? await producer.enqueue({
        tenantId,
        source: `agents:${run.agent_id}`,
        type: 'run',
        payload: { runId: run.id },
        orderingKey: `agent:${run.agent_id}`,
      })
    : null;

  return {
    outcome: 'decided',
    decision: input.decision,
    runId: item.run_id,
    resumed: Boolean(enqueue?.ok),
  };
}
