/**
 * Reads and writes for `agent_drafts` — the durable half of background
 * drafting.
 *
 * The shape to hold onto: a draft belongs to a SUBJECT, and drafting runs
 * with that subject's tool catalog. So every read here is scoped by owner,
 * not merely filtered after the fact — a draft is not something another
 * member of the tenant may collect, however uninteresting its contents.
 */

import type { Kysely } from 'kysely';
import type { DB, Json } from '@renkei/db';
import { isUuid } from '@/lib/uuid';

export type DraftStatus = 'queued' | 'running' | 'succeeded' | 'failed';

export interface DraftRequest {
  /** The prose the person wrote. */
  text: string;
  /** The builder's steps at the moment they asked — revision context. */
  steps: Json;
  triggerVars: Json;
  suggestTriggers: boolean;
  guardrails: string | null;
}

export interface AgentDraft {
  id: string;
  agentId: string | null;
  status: DraftStatus;
  request: DraftRequest;
  /** The drafted document, once it exists. */
  result: Json | null;
  error: string | null;
  errorDetail: string | null;
  createdAt: string;
  finishedAt: string | null;
}

function statusOf(value: string): DraftStatus {
  return value === 'running' || value === 'succeeded' || value === 'failed' ? value : 'queued';
}

function requestOf(value: Json): DraftRequest {
  // The row's own jsonb, so its members are already Json — narrowing by
  // annotation rather than assertion keeps that true without claiming it.
  const record: { [key: string]: Json | undefined } =
    typeof value === 'object' && value !== null && !Array.isArray(value) ? value : {};
  const steps = record.steps;
  const triggerVars = record.triggerVars;
  return {
    text: typeof record.text === 'string' ? record.text : '',
    steps: steps === undefined ? null : steps,
    triggerVars: triggerVars === undefined ? null : triggerVars,
    suggestTriggers: record.suggestTriggers === true,
    guardrails: typeof record.guardrails === 'string' ? record.guardrails : null,
  };
}

interface DraftRow {
  id: string;
  agent_id: string | null;
  status: string;
  request: Json;
  result: Json | null;
  error: string | null;
  error_detail: string | null;
  created_at: Date;
  finished_at: Date | null;
}

function viewOf(row: DraftRow): AgentDraft {
  return {
    id: row.id,
    agentId: row.agent_id,
    status: statusOf(row.status),
    request: requestOf(row.request),
    result: row.result,
    error: row.error,
    errorDetail: row.error_detail,
    createdAt: row.created_at.toISOString(),
    finishedAt: row.finished_at ? row.finished_at.toISOString() : null,
  };
}

const DRAFT_COLUMNS = [
  'id',
  'agent_id',
  'status',
  'request',
  'result',
  'error',
  'error_detail',
  'created_at',
  'finished_at',
] as const;

/** Start a draft. The queue job that does the work is enqueued by the caller. */
export async function createDraft(
  db: Kysely<DB>,
  params: {
    tenantId: string;
    ownerSubject: string;
    agentId: string | null;
    request: DraftRequest;
  }
): Promise<string> {
  const row = await db
    .insertInto('agent_drafts')
    .values({
      tenant_id: params.tenantId,
      owner_subject: params.ownerSubject,
      agent_id: params.agentId,
      status: 'queued',
      // Kysely wants the jsonb column as a string.
      request: JSON.stringify(params.request),
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  return row.id;
}

/** One draft, for its owner. Null for anyone else, which is the same answer. */
export async function getDraft(
  db: Kysely<DB>,
  tenantId: string,
  ownerSubject: string,
  draftId: string
): Promise<AgentDraft | null> {
  if (!isUuid(draftId)) return null;
  const row = await db
    .selectFrom('agent_drafts')
    .select(DRAFT_COLUMNS)
    .where('tenant_id', '=', tenantId)
    .where('owner_subject', '=', ownerSubject)
    .where('id', '=', draftId)
    .executeTakeFirst();
  return row ? viewOf(row) : null;
}

/**
 * The draft the builder should offer when it opens.
 *
 * The newest SUCCEEDED one for this agent (or, with no agent, for this
 * person's next agent) that has not been used yet. Deliberately not the
 * newest of any status: a queued draft has nothing to offer, and a failed
 * one is reported through the draft the builder is already polling rather
 * than resurrected on a later visit as though it were a result.
 */
export async function latestReadyDraft(
  db: Kysely<DB>,
  tenantId: string,
  ownerSubject: string,
  agentId: string | null
): Promise<AgentDraft | null> {
  let query = db
    .selectFrom('agent_drafts')
    .select(DRAFT_COLUMNS)
    .where('tenant_id', '=', tenantId)
    .where('owner_subject', '=', ownerSubject)
    .where('status', '=', 'succeeded')
    // Not yet picked up. Without this the same result is offered on every
    // open, which reads as the draft having run again.
    .where('consumed_at', 'is', null);
  query =
    agentId === null ? query.where('agent_id', 'is', null) : query.where('agent_id', '=', agentId);
  const row = await query.orderBy('created_at', 'desc').limit(1).executeTakeFirst();
  return row ? viewOf(row) : null;
}

/**
 * Mark a draft as picked up by the builder.
 *
 * Called when the result is actually LOADED into the editor, not when it is
 * merely offered — dismissing the offer leaves the draft available, because
 * "not now" and "never" are different answers.
 */
export async function consumeDraft(
  db: Kysely<DB>,
  tenantId: string,
  ownerSubject: string,
  draftId: string
): Promise<void> {
  if (!isUuid(draftId)) return;
  await db
    .updateTable('agent_drafts')
    .set({ consumed_at: new Date(), updated_at: new Date() })
    .where('tenant_id', '=', tenantId)
    .where('owner_subject', '=', ownerSubject)
    .where('id', '=', draftId)
    .execute();
}

/**
 * Mark a draft as being worked on.
 *
 * The `queued` guard is what makes a redelivered queue row a no-op rather
 * than a second model call: whoever wins this UPDATE proceeds, and a
 * duplicate finds zero rows and stops. Same shape as the trigger firing
 * lock, and for the same reason.
 */
export async function claimDraft(db: Kysely<DB>, draftId: string): Promise<boolean> {
  const result = await db
    .updateTable('agent_drafts')
    .set({ status: 'running', attempts: (eb) => eb('attempts', '+', 1), updated_at: new Date() })
    .where('id', '=', draftId)
    .where('status', '=', 'queued')
    .executeTakeFirst();
  return Number(result.numUpdatedRows) > 0;
}

export async function finishDraft(
  db: Kysely<DB>,
  draftId: string,
  outcome:
    | { status: 'succeeded'; result: unknown }
    | { status: 'failed'; error: string; detail?: string | null }
): Promise<void> {
  await db
    .updateTable('agent_drafts')
    .set(
      outcome.status === 'succeeded'
        ? {
            status: 'succeeded',
            result: JSON.stringify(outcome.result),
            error: null,
            error_detail: null,
            finished_at: new Date(),
            updated_at: new Date(),
          }
        : {
            status: 'failed',
            error: outcome.error.slice(0, 2000),
            error_detail: outcome.detail ? outcome.detail.slice(0, 4000) : null,
            finished_at: new Date(),
            updated_at: new Date(),
          }
    )
    .where('id', '=', draftId)
    .execute();
}
