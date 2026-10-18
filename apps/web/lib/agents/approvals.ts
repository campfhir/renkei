/**
 * The human half of a paused run: reading what is waiting on someone, and
 * deciding one — a staged action batch (accept or decline it, whole), or
 * an `ask_person` question.
 *
 * A pause parks its run as 'waiting' and puts a card on the owner's feed.
 * Until now the only way to answer that card was the web feed's buttons —
 * the decision route owned both the claim semantics and the wake, so
 * nothing else could offer the same thing without copying them. An agent
 * that pauses for a person is not much use to someone working through a
 * chat client that cannot answer it.
 *
 * So the semantics live here, once, and the route and the MCP tools are
 * both callers:
 *
 *  - The card's optimistic `suggested → approved|declined|answered` claim
 *    is the SINGLE arbiter. The engine and the timeout sweep race through
 *    the same UPDATE, and the loser of a concurrent decision is told so
 *    rather than silently overwriting a decision that already stands.
 *  - Run-status transitions belong to the ENGINE alone. A decision claims
 *    the card and enqueues {runId}; the worker reads the card and
 *    resolves the pause.
 *  - A failed enqueue does NOT roll the decision back. The claim is
 *    durable, and the approval sweep's decided-but-stuck arm resumes the
 *    run within minutes — so the honest answer is "decided, resuming
 *    shortly", never "it did not happen".
 */

import { sql, type Kysely } from 'kysely';
import type { DB } from '@renkei/db';
import type { QueueProducer } from '@renkei/queue';
import {
  MAX_QUESTION_ANSWER_CHARS,
  checkQuestionAnswers,
  flattenFormFields,
  parseFormNodes,
  parseStoredActions,
  type FormNode,
  type QuestionAnswerIssue,
  type StagedAction,
} from '@renkei/agents';

export interface PendingApproval {
  /** The card id — what a decision names. */
  cardId: string;
  runId: string;
  agentId: string;
  agentName: string;
  /** The card headline, e.g. "Sunday Deep Sweep — wants to make 2 changes". */
  title: string;
  /** What the agent says the batch does and why. */
  summary: string;
  /** The staged actions, in the order the executor would run them. */
  actions: StagedAction[];
  raisedAt: string;
  /**
   * When the wait runs out and the run treats it as denied. Null only for
   * a card whose run has since stopped waiting.
   */
  waitingUntil: string | null;
}

/** The staged batch the engine snapshotted onto the card. */
export function batchProposalOf(suggestedAction: unknown): StagedAction[] {
  if (typeof suggestedAction !== 'object' || suggestedAction === null) return [];
  const proposal: { actions?: unknown } = suggestedAction;
  return parseStoredActions(proposal.actions);
}

/**
 * The gate approvals waiting on this person, oldest first — the one that
 * has been waiting longest is the one about to time out.
 *
 * Owner-scoped by construction: the engine writes `owner_subject` = the
 * run's owner, so someone else's approval is not in this list and is not
 * decidable through `decideApproval` either.
 */
export async function listPendingApprovals(
  db: Kysely<DB>,
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
    .where('c.owner_subject', '=', subject)
    .where('c.kind', '=', 'approval')
    // 'suggested' is the only undecided state; the sweep expires the rest.
    .where('c.status', '=', 'suggested')
    .where('c.archived_at', 'is', null)
    .orderBy('c.created_at', 'asc')
    .limit(Math.min(Math.max(options.limit ?? 20, 1), 50));
  if (options.agentId) query = query.where('a.id', '=', options.agentId);

  const rows = await query.execute();
  return rows.flatMap((row) => {
    if (!row.runId) return [];
    return [
      {
        cardId: row.cardId,
        runId: row.runId,
        agentId: row.agentId,
        agentName: row.agentName,
        title: row.title,
        summary: row.summary ?? '',
        actions: batchProposalOf(row.suggestedAction),
        raisedAt: new Date(row.createdAt).toISOString(),
        waitingUntil: row.waitingUntil ? new Date(row.waitingUntil).toISOString() : null,
      },
    ];
  });
}

export type ApprovalDecision = 'approve' | 'decline';

export type DecideApprovalResult =
  | { outcome: 'not-found' }
  | { outcome: 'not-approval' }
  | { outcome: 'already-decided'; status: string }
  | { outcome: 'comment-too-long'; max: number }
  /** The claim won. `resumed` false means the sweep will wake the run. */
  | { outcome: 'decided'; decision: ApprovalDecision; runId: string; resumed: boolean };

/**
 * Decide one staged batch's card — the whole batch, accepted or declined —
 * and wake its run. Accepting never runs anything here: the engine reads
 * the card on its next turn and hands the batch to the action executor;
 * this only claims the card and enqueues the resume.
 *
 * The producer is a parameter rather than an import so this stays testable
 * and so the queue is the caller's concern — the same shape `createAgentRun`
 * uses.
 */
export async function decideApproval(
  db: Kysely<DB>,
  producer: QueueProducer,
  subject: string,
  input: {
    cardId: string;
    decision: ApprovalDecision;
    /** What the person typed alongside their decision, if anything — the agent reads it. */
    comment?: string | undefined;
  }
): Promise<DecideApprovalResult> {
  const comment = typeof input.comment === 'string' ? input.comment.trim() : '';
  if (comment.length > MAX_QUESTION_ANSWER_CHARS) {
    return { outcome: 'comment-too-long', max: MAX_QUESTION_ANSWER_CHARS };
  }

  // Owner-scoped: someone else's card reads as not-found, never as
  // forbidden — the same rule every agents read follows.
  const item = await db
    .selectFrom('actionable_items')
    .select(['id', 'kind', 'status', 'run_id'])
    .where('id', '=', input.cardId)
    .where('owner_subject', '=', subject)
    .executeTakeFirst();
  if (!item) return { outcome: 'not-found' };
  if (item.kind !== 'approval' || !item.run_id) return { outcome: 'not-approval' };
  if (item.status !== 'suggested') return { outcome: 'already-decided', status: item.status };

  // The optimistic claim: exactly one decider wins; decided beats expired.
  const claimed = await db
    .updateTable('actionable_items')
    .set({
      status: input.decision === 'approve' ? 'approved' : 'declined',
      result: JSON.stringify({
        ...(comment ? { comment } : {}),
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
    .executeTakeFirst();
  const enqueue = run
    ? await producer.enqueue({
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

export interface PendingQuestion {
  cardId: string;
  runId: string;
  agentId: string;
  agentName: string;
  title: string;
  /** What is being asked, plain prose. */
  message: string;
  /** Structure beyond the open question, as the model built it. */
  form: FormNode[];
  raisedAt: string;
  waitingUntil: string | null;
}

/** {message, form} the model's ask_person call snapshotted onto the card. */
function questionOf(suggestedAction: unknown): { message: string; form: FormNode[] } {
  if (typeof suggestedAction !== 'object' || suggestedAction === null) {
    return { message: '', form: [] };
  }
  const action: { message?: unknown; form?: unknown } = suggestedAction;
  return {
    message: typeof action.message === 'string' ? action.message : '',
    form: parseFormNodes(action.form),
  };
}

/** The questions waiting on this person, oldest first. */
export async function listPendingQuestions(
  db: Kysely<DB>,
  subject: string,
  options: { agentId?: string | undefined; limit?: number | undefined } = {}
): Promise<PendingQuestion[]> {
  let query = db
    .selectFrom('actionable_items as c')
    .innerJoin('agents as a', 'a.id', 'c.created_by_agent_id')
    .leftJoin('agent_runs as r', 'r.id', 'c.run_id')
    .select([
      'c.id as cardId',
      'c.run_id as runId',
      'c.title as title',
      'c.suggested_action as suggestedAction',
      'c.created_at as createdAt',
      'a.id as agentId',
      'a.name as agentName',
      'r.waiting_until as waitingUntil',
    ])
    .where('c.owner_subject', '=', subject)
    .where('c.kind', '=', 'question')
    .where('c.status', '=', 'suggested')
    .where('c.archived_at', 'is', null)
    .orderBy('c.created_at', 'asc')
    .limit(Math.min(Math.max(options.limit ?? 20, 1), 50));
  if (options.agentId) query = query.where('a.id', '=', options.agentId);

  const rows = await query.execute();
  return rows.flatMap((row) => {
    if (!row.runId) return [];
    const { message, form } = questionOf(row.suggestedAction);
    return [
      {
        cardId: row.cardId,
        runId: row.runId,
        agentId: row.agentId,
        agentName: row.agentName,
        title: row.title,
        message,
        form,
        raisedAt: new Date(row.createdAt).toISOString(),
        waitingUntil: row.waitingUntil ? new Date(row.waitingUntil).toISOString() : null,
      },
    ];
  });
}

export type AnswerQuestionResult =
  | { outcome: 'not-found' }
  | { outcome: 'not-question' }
  | { outcome: 'already-decided'; status: string }
  /** The reply does not fit the form that asked. */
  | { outcome: 'invalid-answers'; issues: QuestionAnswerIssue[] }
  | { outcome: 'answered'; runId: string; resumed: boolean };

/**
 * Answer one `ask_person` card's form and wake its run. Checked against
 * the form the card was raised with — the browser's copy can be stale,
 * and an MCP caller never saw one, so this is the last place both are in
 * hand.
 */
export async function answerQuestion(
  db: Kysely<DB>,
  producer: QueueProducer,
  subject: string,
  input: { cardId: string; answers: unknown }
): Promise<AnswerQuestionResult> {
  const item = await db
    .selectFrom('actionable_items')
    .select(['id', 'kind', 'status', 'run_id', 'suggested_action'])
    .where('id', '=', input.cardId)
    .where('owner_subject', '=', subject)
    .executeTakeFirst();
  if (!item) return { outcome: 'not-found' };
  if (item.kind !== 'question' || !item.run_id) return { outcome: 'not-question' };
  if (item.status !== 'suggested') return { outcome: 'already-decided', status: item.status };

  const { form } = questionOf(item.suggested_action);
  const checked = checkQuestionAnswers(flattenFormFields(form), input.answers);
  if (!checked.ok) return { outcome: 'invalid-answers', issues: checked.issues };

  const claimed = await db
    .updateTable('actionable_items')
    .set({
      status: 'answered',
      result: JSON.stringify({ answers: checked.values, decidedBy: subject }),
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

  const run = await db
    .selectFrom('agent_runs')
    .select(['id', 'agent_id'])
    .where('id', '=', item.run_id)
    .executeTakeFirst();
  const enqueue = run
    ? await producer.enqueue({
        source: `agents:${run.agent_id}`,
        type: 'run',
        payload: { runId: run.id },
        orderingKey: `agent:${run.agent_id}`,
      })
    : null;

  return { outcome: 'answered', runId: item.run_id, resumed: Boolean(enqueue?.ok) };
}
