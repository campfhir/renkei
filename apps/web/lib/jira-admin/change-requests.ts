/**
 * Jira admin change requests (migration 120) — the stored half of the
 * confirm rule for Jira administration
 * (docs/project-management-design.md).
 *
 * A `jira_admin_propose_*` tool writes a row here and changes nothing in
 * Jira. The owner applies it from a signed-in browser session
 * (app/api/jira-admin/changes/[changeId]/apply), and only
 * the owner: every read and write below is scoped by (tenant, subject), so
 * someone else's request is "not found" rather than refused — an id alone
 * is not an existence oracle.
 *
 * Two states are read from the clock rather than stored: a pending row
 * past `expires_at` is 'expired' (nothing sweeps it; the apply claim simply
 * refuses it), and an 'applying' row whose apply request never finished —
 * a restart mid-apply — reads as 'interrupted' after a few minutes, since
 * nobody can tell from here which of its operations reached Jira.
 */

import { sql, type Kysely } from 'kysely';
import type { DB } from '@renkei/db';
import { isUuid } from '@/lib/uuid';
import { notifyOperatorsOfRequest } from '@/lib/admin-changes/notify';

/** How long a proposal can wait for its review. */
export const CHANGE_REQUEST_TTL_HOURS = 24;

/**
 * A job that has not touched its row for this long lost its process. The
 * running job touches it every few seconds (apply-job.ts), so this is a
 * dead job, not a slow one.
 */
export const JOB_STALE_MS = 90 * 1000;

export type ChangeRequestStatus =
  'pending' | 'queued' | 'applying' | 'applied' | 'partial' | 'failed' | 'cancelled';

/**
 * A free-text ask from someone who cannot build a proposal: nothing to
 * apply, an operator turns it into a proposal or declines it.
 */
export const REQUEST_KIND = 'request';

/** What a person is shown: the stored status, plus the two read from the clock. */
export type ChangeRequestState = ChangeRequestStatus | 'expired' | 'interrupted';

/** What one operation did when the request was applied. */
export interface OperationResult {
  /** The operation in plain words: "Add 2 options: Vendor, Partner". */
  label: string;
  outcome: 'done' | 'failed' | 'not_run';
  /** Why it failed, or a note on what was done. */
  detail?: string;
}

export interface ChangeRequest {
  id: string;
  subject: string;
  /** The agent that proposed it, when an agent run did. */
  agentId: string | null;
  cloudId: string;
  siteUrl: string | null;
  kind: string;
  title: string;
  reason: string | null;
  /** Shaped by `kind` — each kind's module reads its own. */
  payload: unknown;
  status: ChangeRequestStatus;
  results: OperationResult[] | null;
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
  appliedBy: string | null;
  appliedAt: Date | null;
  cancelledAt: Date | null;
  /** The operator who approved it, whose own connection the job acts on. */
  approvedBy: string | null;
  approvedAt: Date | null;
  /** What the job is doing right now, while it is queued or applying. */
  step: string | null;
  /** Why it was declined, or what it was built as — for the requester. */
  resolution: string | null;
}

const STATUSES: readonly ChangeRequestStatus[] = [
  'pending',
  'queued',
  'applying',
  'applied',
  'partial',
  'failed',
  'cancelled',
];

function statusOf(value: string): ChangeRequestStatus {
  // The column's CHECK constraint holds it to this list; anything else is
  // a row this code does not understand, and reads as failed, not pending.
  return STATUSES.find((status) => status === value) ?? 'failed';
}

function resultsOf(value: unknown): OperationResult[] | null {
  if (!Array.isArray(value)) return null;
  return value.flatMap((item: unknown): OperationResult[] => {
    if (typeof item !== 'object' || item === null) return [];
    const entry = Object.fromEntries(Object.entries(item));
    const outcome = entry.outcome;
    if (
      typeof entry.label !== 'string' ||
      (outcome !== 'done' && outcome !== 'failed' && outcome !== 'not_run')
    ) {
      return [];
    }
    return [
      {
        label: entry.label,
        outcome,
        ...(typeof entry.detail === 'string' ? { detail: entry.detail } : {}),
      },
    ];
  });
}

type Row = {
  id: string;
  subject: string;
  agent_id: string | null;
  cloud_id: string;
  site_url: string | null;
  kind: string;
  title: string;
  reason: string | null;
  payload: unknown;
  status: string;
  results: unknown;
  expires_at: Date;
  created_at: Date;
  updated_at: Date;
  applied_by: string | null;
  applied_at: Date | null;
  cancelled_at: Date | null;
  approved_by: string | null;
  approved_at: Date | null;
  step: string | null;
  resolution: string | null;
};

function fromRow(row: Row): ChangeRequest {
  return {
    id: row.id,
    subject: row.subject,
    agentId: row.agent_id,
    cloudId: row.cloud_id,
    siteUrl: row.site_url,
    kind: row.kind,
    title: row.title,
    reason: row.reason,
    payload: row.payload,
    status: statusOf(row.status),
    results: resultsOf(row.results),
    expiresAt: new Date(row.expires_at),
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
    appliedBy: row.applied_by,
    appliedAt: row.applied_at ? new Date(row.applied_at) : null,
    cancelledAt: row.cancelled_at ? new Date(row.cancelled_at) : null,
    approvedBy: row.approved_by,
    approvedAt: row.approved_at ? new Date(row.approved_at) : null,
    step: row.step,
    resolution: row.resolution,
  };
}

const COLUMNS = [
  'id',
  'subject',
  'agent_id',
  'cloud_id',
  'site_url',
  'kind',
  'title',
  'reason',
  'payload',
  'status',
  'results',
  'expires_at',
  'created_at',
  'updated_at',
  'applied_by',
  'applied_at',
  'cancelled_at',
  'approved_by',
  'approved_at',
  'step',
  'resolution',
] as const;

export function stateOf(
  change: Pick<ChangeRequest, 'status' | 'expiresAt' | 'updatedAt'>,
  now: Date = new Date()
): ChangeRequestState {
  if (change.status === 'pending' && change.expiresAt.getTime() <= now.getTime()) return 'expired';
  if (change.status === 'applying' && now.getTime() - change.updatedAt.getTime() > JOB_STALE_MS) {
    return 'interrupted';
  }
  return change.status;
}

export async function createChangeRequest(
  db: Kysely<DB>,
  input: {
    subject: string;
    agentId?: string;
    cloudId: string;
    siteUrl?: string;
    kind: string;
    title: string;
    reason?: string;
    payload: unknown;
  }
): Promise<ChangeRequest> {
  const row = await db
    .insertInto('jira_admin_change_requests')
    .values({
      subject: input.subject,
      agent_id: input.agentId && isUuid(input.agentId) ? input.agentId : null,
      cloud_id: input.cloudId,
      site_url: input.siteUrl || null,
      kind: input.kind,
      title: input.title.slice(0, 300),
      reason: input.reason?.trim() ? input.reason.trim() : null,
      payload: JSON.stringify(input.payload),
      expires_at: sql<Date>`NOW() + (${CHANGE_REQUEST_TTL_HOURS} * INTERVAL '1 hour')`,
    })
    .returning(COLUMNS)
    .executeTakeFirstOrThrow();
  const change = fromRow(row);
  // Every proposal tool files through here, so this is the one place that
  // tells the people who approve that something is waiting.
  notifyOperatorsOfRequest({
    db,
    connector: 'jira-admin',
    changeId: change.id,
    title: change.title,
    requester: change.subject,
    freeText: change.kind === REQUEST_KIND,
  });
  return change;
}

/** One of this person's requests, or null — someone else's reads the same as none. */
export async function getChangeRequest(
  db: Kysely<DB>,
  subject: string,
  id: string
): Promise<ChangeRequest | null> {
  if (!isUuid(id)) return null;
  const row = await db
    .selectFrom('jira_admin_change_requests')
    .select(COLUMNS)
    .where('id', '=', id)
    .where('subject', '=', subject)
    .executeTakeFirst();
  return row ? fromRow(row) : null;
}

/** This person's requests, newest first; `pendingOnly` leaves out expired ones too. */
export async function listChangeRequests(
  db: Kysely<DB>,
  subject: string,
  options: { limit?: number; pendingOnly?: boolean } = {}
): Promise<ChangeRequest[]> {
  let query = db
    .selectFrom('jira_admin_change_requests')
    .select(COLUMNS)
    .where('subject', '=', subject);
  if (options.pendingOnly) {
    query = query.where('status', '=', 'pending').where('expires_at', '>', sql<Date>`NOW()`);
  }
  const rows = await query
    .orderBy('created_at', 'desc')
    .limit(options.limit ?? 50)
    .execute();
  return rows.map(fromRow);
}

/** How many of this person's requests are waiting for them, for the connector card. */
export async function countPendingChangeRequests(db: Kysely<DB>, subject: string): Promise<number> {
  const row = await db
    .selectFrom('jira_admin_change_requests')
    .select((eb) => eb.fn.countAll<string>().as('count'))
    .where('subject', '=', subject)
    .where('status', '=', 'pending')
    .where('expires_at', '>', sql<Date>`NOW()`)
    .executeTakeFirst();
  return Number(row?.count ?? 0);
}

/**
 * Take the request for applying. A conditional update, so of two clicks
 * (two tabs, a double submit) exactly one wins; the loser, like an expired
 * or already-decided request, gets false.
 */
export async function claimChangeRequest(
  db: Kysely<DB>,
  subject: string,
  id: string
): Promise<boolean> {
  if (!isUuid(id)) return false;
  const result = await db
    .updateTable('jira_admin_change_requests')
    .set({ status: 'applying', updated_at: sql<Date>`NOW()` })
    .where('id', '=', id)
    .where('subject', '=', subject)
    .where('status', '=', 'pending')
    .where('expires_at', '>', sql<Date>`NOW()`)
    .executeTakeFirst();
  return Number(result.numUpdatedRows ?? 0) > 0;
}

/** Record how an apply ended. Only the claim's holder gets here. */
export async function finishChangeRequest(
  db: Kysely<DB>,
  id: string,
  outcome: {
    status: 'applied' | 'partial' | 'failed';
    results: OperationResult[];
    appliedBy: string;
  }
): Promise<void> {
  await db
    .updateTable('jira_admin_change_requests')
    .set({
      status: outcome.status,
      results: JSON.stringify(outcome.results),
      applied_by: outcome.appliedBy,
      applied_at: sql<Date>`NOW()`,
      updated_at: sql<Date>`NOW()`,
      step: null,
    })
    .where('id', '=', id)
    .where('status', '=', 'applying')
    .execute();
}

const TABLE = 'jira_admin_change_requests';

/**
 * Withdraw a pending request. The requester may withdraw their own; an
 * operator (`operator: true`) may decline anyone's, with a note the
 * requester reads. False when it is not theirs to cancel, or no longer pending.
 */
export async function cancelChangeRequest(
  db: Kysely<DB>,
  subject: string,
  id: string,
  options: { operator?: boolean; note?: string } = {}
): Promise<boolean> {
  if (!isUuid(id)) return false;
  let query = db
    .updateTable(TABLE)
    .set({
      status: 'cancelled',
      cancelled_at: sql<Date>`NOW()`,
      updated_at: sql<Date>`NOW()`,
      ...(options.note?.trim() ? { resolution: options.note.trim().slice(0, 2000) } : {}),
    })
    .where('id', '=', id)
    .where('status', '=', 'pending');
  if (!options.operator) query = query.where('subject', '=', subject);
  const result = await query.executeTakeFirst();
  return Number(result.numUpdatedRows ?? 0) > 0;
}

/** One request by id, whoever owns it. The caller decides who may see it (`mayView`). */
export async function getChangeRequestById(
  db: Kysely<DB>,
  id: string
): Promise<ChangeRequest | null> {
  if (!isUuid(id)) return null;
  const row = await db.selectFrom(TABLE).select(COLUMNS).where('id', '=', id).executeTakeFirst();
  return row ? fromRow(row) : null;
}

/** The requester sees their own; an operator sees everyone's. Anyone else sees nothing. */
export function mayView(
  change: Pick<ChangeRequest, 'subject'>,
  viewer: { subject: string; operator: boolean }
): boolean {
  return viewer.operator || change.subject === viewer.subject;
}

/** Everyone's requests, newest first — an operator's queue. */
export async function listAllChangeRequests(
  db: Kysely<DB>,
  options: { limit?: number } = {}
): Promise<ChangeRequest[]> {
  const rows = await db
    .selectFrom(TABLE)
    .select(COLUMNS)
    .orderBy('created_at', 'desc')
    .limit(options.limit ?? 100)
    .execute();
  return rows.map(fromRow);
}

/** How many requests wait for an operator, for the connector card. */
export async function countAwaitingReview(db: Kysely<DB>): Promise<number> {
  const row = await db
    .selectFrom(TABLE)
    .select((eb) => eb.fn.countAll<string>().as('count'))
    .where('status', '=', 'pending')
    .where('expires_at', '>', sql<Date>`NOW()`)
    .executeTakeFirst();
  return Number(row?.count ?? 0);
}

/**
 * Approve: hand a pending request to the job queue, on this operator's
 * connection. A conditional update, so two approvals cannot both queue it.
 */
export async function queueChangeRequest(
  db: Kysely<DB>,
  id: string,
  approver: string
): Promise<boolean> {
  if (!isUuid(id)) return false;
  const result = await db
    .updateTable(TABLE)
    .set({
      status: 'queued',
      approved_by: approver,
      approved_at: sql<Date>`NOW()`,
      updated_at: sql<Date>`NOW()`,
      step: 'Waiting to start',
    })
    .where('id', '=', id)
    .where('kind', '<>', REQUEST_KIND)
    .where('status', '=', 'pending')
    .where('expires_at', '>', sql<Date>`NOW()`)
    .executeTakeFirst();
  return Number(result.numUpdatedRows ?? 0) > 0;
}

/** The job takes a queued request. Of two processes, exactly one wins. */
export async function startQueuedChange(db: Kysely<DB>, id: string): Promise<boolean> {
  if (!isUuid(id)) return false;
  const result = await db
    .updateTable(TABLE)
    .set({ status: 'applying', updated_at: sql<Date>`NOW()`, step: 'Starting' })
    .where('id', '=', id)
    .where('status', '=', 'queued')
    .executeTakeFirst();
  return Number(result.numUpdatedRows ?? 0) > 0;
}

/**
 * Take over an 'applying' request whose job stopped touching it (its
 * process died). A conditional update on the heartbeat, so of two sweeps
 * exactly one takes it.
 */
export async function reclaimStaleChange(
  db: Kysely<DB>,
  id: string,
  staleMs: number = JOB_STALE_MS
): Promise<boolean> {
  if (!isUuid(id)) return false;
  const result = await db
    .updateTable(TABLE)
    .set({ updated_at: sql<Date>`NOW()` })
    .where('id', '=', id)
    .where('status', '=', 'applying')
    .where('updated_at', '<', sql<Date>`NOW() - (${staleMs} * INTERVAL '1 millisecond')`)
    .executeTakeFirst();
  return Number(result.numUpdatedRows ?? 0) > 0;
}

/**
 * Say what the job is doing, which is also its heartbeat. False once the
 * request is no longer queued or applying.
 */
export async function setStep(db: Kysely<DB>, id: string, step: string): Promise<boolean> {
  const result = await db
    .updateTable(TABLE)
    .set({ step: step.slice(0, 500), updated_at: sql<Date>`NOW()` })
    .where('id', '=', id)
    .where('status', 'in', ['queued', 'applying'])
    .executeTakeFirst();
  return Number(result.numUpdatedRows ?? 0) > 0;
}

/** Ids the job sweep should look at: queued, or applying with a dead job. */
export async function listRunnableChanges(
  db: Kysely<DB>,
  staleMs: number = JOB_STALE_MS,
  limit = 5
): Promise<{ id: string; status: 'queued' | 'applying' }[]> {
  const rows = await db
    .selectFrom(TABLE)
    .select(['id', 'status'])
    .where((eb) =>
      eb.or([
        eb('status', '=', 'queued'),
        eb.and([
          eb('status', '=', 'applying'),
          eb('updated_at', '<', sql<Date>`NOW() - (${staleMs} * INTERVAL '1 millisecond')`),
        ]),
      ])
    )
    .orderBy('updated_at', 'asc')
    .limit(limit)
    .execute();
  return rows.map((row) => ({
    id: row.id,
    status: row.status === 'queued' ? 'queued' : 'applying',
  }));
}

/** An operator built a free-text request into a proposal: close it, saying so. */
export async function closeRequestAsProposed(
  db: Kysely<DB>,
  requestId: string,
  proposalId: string
): Promise<boolean> {
  if (!isUuid(requestId)) return false;
  const result = await db
    .updateTable(TABLE)
    .set({
      status: 'cancelled',
      cancelled_at: sql<Date>`NOW()`,
      updated_at: sql<Date>`NOW()`,
      resolution: `An operator turned this into a proposal (${proposalId}).`,
    })
    .where('id', '=', requestId)
    .where('kind', '=', REQUEST_KIND)
    .where('status', '=', 'pending')
    .executeTakeFirst();
  return Number(result.numUpdatedRows ?? 0) > 0;
}

/** File a free-text request: no operations, just words for an operator. */
export async function createRequest(
  db: Kysely<DB>,
  input: {
    subject: string;
    agentId?: string;
    cloudId: string;
    siteUrl?: string;
    title: string;
    reason?: string;
    description: string;
  }
): Promise<ChangeRequest> {
  return createChangeRequest(db, {
    subject: input.subject,
    agentId: input.agentId,
    cloudId: input.cloudId,
    siteUrl: input.siteUrl,
    kind: REQUEST_KIND,
    title: input.title,
    reason: input.reason,
    payload: { description: input.description },
  });
}

/** The words of a free-text request. */
export function requestDescription(payload: unknown): string {
  if (typeof payload !== 'object' || payload === null) return '';
  const description = Object.fromEntries(Object.entries(payload)).description;
  return typeof description === 'string' ? description : '';
}
