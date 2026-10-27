/**
 * Run history reads, with the visibility rule applied AT THE QUERY SEAM.
 *
 * Two audiences, one schema: status/outcome/timing columns are content-free
 * and safe for any org operator; the turns' `detail` jsonb and the staged
 * batches' actions are CONTENT. The owner gets it always; an admin gets it
 * only on a FAILED run — enough to troubleshoot a broken agent, nothing of
 * a working one's inner life. The
 * projection happens here, in the functions pages call, so no page can
 * forget to redact: the admin functions never even SELECT what they must
 * not show.
 */

import {
  getDataStore,
  type AgentAdminRecord,
  type Json,
  type RunAudience,
  type RunDetailRecord,
  type RunSummaryRecord,
} from '@renkei/db';
import {
  mergeOpenedDetail,
  parseAgentDefinition,
  parseStoredActions,
  parseStoredResults,
  sealedDetailOf,
  type ActionResult,
  type AgentDefinition,
  type StagedAction,
} from '@renkei/agents';
import { delegateClient } from '@renkei/delegate-client';
import { isUuid } from '@/lib/uuid';
import { unavailableMarker } from '@/lib/chat/content-crypto';
import { unavailableReasonOf } from '@/lib/chat/chat-keys';

export interface RunSummary {
  id: string;
  status: string;
  triggerKind: string;
  errorKind: string | null;
  error: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  /** Milliseconds, when both ends exist. */
  durationMs: number | null;
  /** How many times an owner resumed this run from a failure (migration 099). */
  resumeCount: number;
  /** The latest resume, when there was one. */
  resumedAt: string | null;
}

/**
 * One model turn of a run (an agent_run_steps row with step_id 'turn'):
 * what the agent said and called, and what came back.
 */
export interface AttemptView {
  stepId: string;
  stepIndex: number;
  /** The turn number, from 1. */
  attempt: number;
  iteration: number;
  status: string;
  outcome: string | null;
  outcomeCode: string | null;
  toolCallCount: number;
  startedAt: string | null;
  finishedAt: string | null;
  /** Absent = redacted (admin viewing a non-failed attempt). */
  detail?: Json;
  redacted: boolean;
}

/** A batch of staged actions, as the run page shows it. */
export interface ActionBatchView {
  id: string;
  /** The turn that staged it. */
  turn: number;
  status: string;
  /** Why a person had to accept it ('owner' | 'high-risk' | 'policy'); null = auto-accepted. */
  reviewReason: string | null;
  acceptedBy: string | null;
  createdAt: string;
  finishedAt: string | null;
  /** Content — absent when redacted, by the same rule as the turns'. */
  summary?: string;
  actions?: StagedAction[];
  results?: ActionResult[];
  comment?: string | null;
  /** How many actions it held — visible even when the content is not. */
  actionCount: number;
}

export interface RunDetail extends RunSummary {
  /** What the run executed: its instructions and tools, frozen at start. */
  definition: AgentDefinition | null;
  /** The run's model turns, in order. */
  attempts: AttemptView[];
  /** The action batches it staged, in order. */
  batches: ActionBatchView[];
  /** The run's active-time clock, in ms (waits on a person excluded). */
  activeMs: number;
  /**
   * What the trigger handed the run — the `trigger.*` variables it started
   * with. Absent when redacted, which follows the SAME rule the per-attempt
   * detail does: the owner always, an admin only on a failed run. It is
   * content (an email's subject, a message's text), so it cannot be treated
   * as the content-free status columns are.
   */
  initialState?: Json;
  initialStateRedacted: boolean;
  /**
   * What the owner said to do differently when they last resumed the run.
   * Content the owner wrote, so it follows the owner-always /
   * admin-on-failure rule the turn detail does.
   */
  resumeGuidance: string | null;
}

function iso(value: Date | null): string | null {
  return value ? value.toISOString() : null;
}

function summaryOf(row: RunSummaryRecord): RunSummary {
  return {
    id: row.id,
    status: row.status,
    triggerKind: row.triggerKind,
    errorKind: row.errorKind,
    error: row.error,
    createdAt: row.createdAt.toISOString(),
    startedAt: iso(row.startedAt),
    finishedAt: iso(row.finishedAt),
    durationMs:
      row.startedAt && row.finishedAt ? row.finishedAt.getTime() - row.startedAt.getTime() : null,
    resumeCount: row.resumeCount,
    resumedAt: iso(row.resumedAt),
  };
}

/**
 * Every status a run can be in — the one authoritative list. The runs
 * pages' filter tabs, the MCP surface, and the query options all read
 * this so a status added later cannot be missed by one of them.
 */
export const RUN_STATUSES = [
  'queued',
  'running',
  'waiting',
  'succeeded',
  'failed',
  'stopped',
  'canceled',
] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

export function isRunStatus(value: string | undefined): value is RunStatus {
  return RUN_STATUSES.some((status) => status === value);
}

interface RunListOptions {
  status?: RunStatus;
  /**
   * Free-text search. The owner sees everything about their own runs, so
   * the search may read content: the error text, the trigger kind, and
   * the trigger input (the payload the run started from — the thing a
   * person actually remembers about "that particular run"); an admin's
   * matches the input only on failed runs — a match count over healthy
   * runs' content would leak by side channel what the admin cannot read.
   * A pasted run id matches exactly.
   */
  q?: string;
  limit?: number;
}

async function listRuns(
  agentId: string,
  ownerSubject: string | null,
  audience: RunAudience,
  options: RunListOptions
): Promise<RunSummary[]> {
  if (!isUuid(agentId)) return [];
  const q = options.q?.trim();
  const rows = await getDataStore().agentRuns.list({
    agentId,
    ownerSubject,
    audience,
    ...(options.status ? { status: options.status } : {}),
    ...(q ? { q } : {}),
    ...(q && isUuid(q) ? { matchId: q } : {}),
    limit: options.limit ?? 50,
  });
  return rows.map(summaryOf);
}

export async function listRunsForOwner(
  ownerSubject: string,
  agentId: string,
  options: RunListOptions = {}
): Promise<RunSummary[]> {
  return listRuns(agentId, ownerSubject, 'owner', options);
}

/**
 * Attempt rows with their sealed content opened AS THE RUN'S OWNER
 * (step-detail.ts in @renkei/agents): the content half of a finished
 * attempt is one `uenc1:` envelope under the owner's automation key, and
 * the delegate opens it for whoever may read the row — the owner through
 * their session, an admin on a failed run through the owner's automation
 * delegation, which is exactly the key the run itself wrote under. When
 * that delegation is not live (the owner has not signed in for a month,
 * or has paused their agents) the row renders the marker the chat uses
 * for a locked row, in place of the summary, rather than failing the
 * page. Rows without an envelope — pauses, rows from before sealing —
 * pass through as they are.
 */
async function openAttemptDetails<T extends { detail: Json | null }>(
  ownerSubject: string,
  rows: T[]
): Promise<T[]> {
  const envelopes = rows.map((row) => sealedDetailOf(row.detail));
  const stored = envelopes.flatMap((envelope) => (envelope === null ? [] : [envelope]));
  if (stored.length === 0) return rows;
  const opened = await delegateClient().openForSubject(ownerSubject, stored);
  const marker = opened.ok
    ? unavailableMarker('failed')
    : unavailableMarker(unavailableReasonOf(opened.err.type));
  let next = 0;
  return rows.map((row, index) => {
    if (envelopes[index] === null) return row;
    const plaintext = opened.ok ? (opened.val[next] ?? null) : null;
    next += 1;
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
    return { ...row, detail: mergeOpenedDetail(row.detail, plaintext, marker) as Json };
  });
}

async function runDetail(record: RunDetailRecord, audience: RunAudience): Promise<RunDetail> {
  const storedRows = record.steps;
  // THE visibility rule: content for the owner always; for an admin only
  // when the RUN failed (troubleshooting is their job, reading a working
  // agent's content is not). A run's turns are one conversation, so the
  // rule is the run's, not the turn's. Only what this audience may see is
  // opened: an admin's view of a working run never asks the delegate.
  const contentVisible = audience === 'owner' || record.status === 'failed';
  const contentRows = contentVisible ? storedRows : [];
  const openedById = new Map(
    (await openAttemptDetails(record.ownerSubject, contentRows)).map(
      (row) => [`${row.stepId}:${row.iteration}:${row.attempt}`, row.detail] as const
    )
  );
  const attemptRows = storedRows.map((row) => ({
    ...row,
    detail: openedById.get(`${row.stepId}:${row.iteration}:${row.attempt}`) ?? row.detail,
  }));

  return {
    ...summaryOf(record),
    definition: parseAgentDefinition(record.definitionSnapshot),
    activeMs: record.activeMs,
    ...(contentVisible && record.initialState !== null
      ? { initialState: record.initialState }
      : {}),
    initialStateRedacted: !contentVisible,
    resumeGuidance: contentVisible ? record.resumeGuidance : null,
    batches: record.batches.map((row) => {
      const actions = parseStoredActions(row.actions);
      return {
        id: row.id,
        turn: row.turn,
        status: row.status,
        reviewReason: row.reviewReason,
        acceptedBy: row.acceptedBy,
        createdAt: row.createdAt.toISOString(),
        finishedAt: iso(row.finishedAt),
        actionCount: actions.length,
        ...(contentVisible
          ? {
              summary: row.summary,
              actions,
              results: parseStoredResults(row.results),
              comment: row.comment,
            }
          : {}),
      };
    }),
    attempts: attemptRows.map((row) => ({
      stepId: row.stepId,
      stepIndex: row.stepIndex,
      attempt: row.attempt,
      iteration: row.iteration,
      status: row.status,
      outcome: row.outcome,
      outcomeCode: row.outcomeCode,
      toolCallCount: row.toolCallCount,
      startedAt: iso(row.startedAt),
      finishedAt: iso(row.finishedAt),
      ...(contentVisible && row.detail !== null ? { detail: row.detail } : {}),
      redacted: !contentVisible,
    })),
  };
}

export async function getRunForOwner(
  ownerSubject: string,
  agentId: string,
  runId: string
): Promise<RunDetail | null> {
  if (!isUuid(agentId) || !isUuid(runId)) return null;
  const record = await getDataStore().agentRuns.findDetail({
    agentId,
    runId,
    ownerSubject,
    audience: 'owner',
  });
  return record ? runDetail(record, 'owner') : null;
}

/** Admin oversight: any agent's runs, statuses always, content on failures. */
export async function listRunsForAdmin(
  agentId: string,
  options: RunListOptions = {}
): Promise<RunSummary[]> {
  return listRuns(agentId, null, 'admin', options);
}

/**
 * Admin run detail. The store withholds the trigger payload and resume
 * note of a non-failed run from this audience at the query itself, so
 * content an admin may not see never leaves the database; runDetail
 * applies the same rule again to the turns and batches.
 */
export async function getRunForAdmin(agentId: string, runId: string): Promise<RunDetail | null> {
  if (!isUuid(agentId) || !isUuid(runId)) return null;
  const record = await getDataStore().agentRuns.findDetail({
    agentId,
    runId,
    ownerSubject: null,
    audience: 'admin',
  });
  return record ? runDetail(record, 'admin') : null;
}

export interface AdminAgentRow {
  id: string;
  name: string;
  ownerSubject: string;
  ownerEmail: string | null;
  enabled: boolean;
  descriptionStatus: string;
  lastRunAt: string | null;
}

export interface AdminAgentDetail extends AdminAgentRow {
  description: string | null;
}

function adminRowOf(record: AgentAdminRecord): AdminAgentDetail {
  return {
    id: record.id,
    name: record.name,
    ownerSubject: record.ownerSubject,
    ownerEmail: record.ownerEmail,
    enabled: record.enabled,
    description: record.description,
    descriptionStatus: record.descriptionStatus,
    lastRunAt: iso(record.lastRunAt),
  };
}

/** One agent, for the admin detail page — the single-row sibling of listAgentsForAdmin. */
export async function getAgentForAdmin(agentId: string): Promise<AdminAgentDetail | null> {
  if (!isUuid(agentId)) return null;
  const record = await getDataStore().agents.findForAdmin(agentId);
  return record ? adminRowOf(record) : null;
}

/**
 * Every agent in the org, or every agent owned by one person — the shared
 * query behind the oversight list and the per-person view on Organization
 * usage. Run and failure tallies come from the run log (agent_run_log),
 * not from here: run ROWS are pruned by retention, the log is not.
 */
async function listAgentRows(ownerSubject: string | null): Promise<AdminAgentRow[]> {
  const records = await getDataStore().agents.listForAdmin({ ownerSubject });
  return records.map((record) => {
    const { description: _description, ...row } = adminRowOf(record);
    return row;
  });
}

export async function listAgentsForAdmin(): Promise<AdminAgentRow[]> {
  return listAgentRows(null);
}

/** One person's own agents — the per-person view on Organization usage. */
export async function listAgentsForOwner(ownerSubject: string): Promise<AdminAgentRow[]> {
  return listAgentRows(ownerSubject);
}
