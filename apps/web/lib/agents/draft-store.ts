/**
 * Reads and writes for `agent_drafts` — the durable half of background
 * drafting.
 *
 * The shape to hold onto: a draft belongs to a SUBJECT, and drafting runs
 * with that subject's tool catalog. So every read here is scoped by owner,
 * not merely filtered after the fact — a draft is not something another
 * member of the tenant may collect, however uninteresting its contents.
 */

import { getDataStore, type AgentDraftRecord, type Json } from '@renkei/db';
import { isUuid } from '@/lib/uuid';

export type DraftStatus = 'queued' | 'running' | 'succeeded' | 'failed';

export interface DraftRequest {
  /** The prose the person wrote. */
  text: string;
  /**
   * The builder's instructions and tools at the moment they asked —
   * revision context ({instructions, tools}), or null for a new agent.
   */
  current: Json;
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
  const current = record.current;
  const triggerVars = record.triggerVars;
  return {
    text: typeof record.text === 'string' ? record.text : '',
    current: current === undefined ? null : current,
    triggerVars: triggerVars === undefined ? null : triggerVars,
    suggestTriggers: record.suggestTriggers === true,
    guardrails: typeof record.guardrails === 'string' ? record.guardrails : null,
  };
}

function viewOf(row: AgentDraftRecord): AgentDraft {
  return {
    id: row.id,
    agentId: row.agentId,
    status: statusOf(row.status),
    request: requestOf(row.request),
    result: row.result,
    error: row.error,
    errorDetail: row.errorDetail,
    createdAt: row.createdAt.toISOString(),
    finishedAt: row.finishedAt ? row.finishedAt.toISOString() : null,
  };
}

/** Start a draft. The queue job that does the work is enqueued by the caller. */
export async function createDraft(params: {
  ownerSubject: string;
  agentId: string | null;
  request: DraftRequest;
}): Promise<string> {
  return getDataStore().agentDrafts.create({
    ownerSubject: params.ownerSubject,
    agentId: params.agentId,
    request: asJson(params.request),
  });
}

/** One draft, for its owner. Null for anyone else, which is the same answer. */
export async function getDraft(ownerSubject: string, draftId: string): Promise<AgentDraft | null> {
  if (!isUuid(draftId)) return null;
  const row = await getDataStore().agentDrafts.find(ownerSubject, draftId);
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
  ownerSubject: string,
  agentId: string | null
): Promise<AgentDraft | null> {
  if (agentId !== null && !isUuid(agentId)) return null;
  const row = await getDataStore().agentDrafts.latestReady(ownerSubject, agentId);
  return row ? viewOf(row) : null;
}

/**
 * Mark a draft as picked up by the builder.
 *
 * Called when the result is actually LOADED into the editor, not when it is
 * merely offered — dismissing the offer leaves the draft available, because
 * "not now" and "never" are different answers.
 */
export async function consumeDraft(ownerSubject: string, draftId: string): Promise<void> {
  if (!isUuid(draftId)) return;
  await getDataStore().agentDrafts.consume(ownerSubject, draftId);
}

/**
 * Mark a draft as being worked on.
 *
 * The `queued` guard is what makes a redelivered queue row a no-op rather
 * than a second model call: whoever wins this UPDATE proceeds, and a
 * duplicate finds zero rows and stops. Same shape as the trigger firing
 * lock, and for the same reason.
 */
export async function claimDraft(draftId: string): Promise<boolean> {
  return getDataStore().agentDrafts.claim(draftId);
}

export async function finishDraft(
  draftId: string,
  outcome:
    | { status: 'succeeded'; result: unknown }
    | { status: 'failed'; error: string; detail?: string | null }
): Promise<void> {
  await getDataStore().agentDrafts.finish(
    draftId,
    outcome.status === 'succeeded'
      ? { status: 'succeeded', result: asJson(outcome.result) }
      : {
          status: 'failed',
          error: outcome.error.slice(0, 2000),
          detail: outcome.detail ? outcome.detail.slice(0, 4000) : null,
        }
  );
}

/** A value as the JSON it is stored as (what JSON.stringify keeps of it). */
function asJson(value: unknown): Json {
  const json: Json = JSON.parse(JSON.stringify(value ?? null));
  return json;
}

/** Remove a draft whose job could not be queued. */
export async function deleteDraft(draftId: string): Promise<void> {
  await getDataStore().agentDrafts.delete(draftId);
}
