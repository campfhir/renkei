/**
 * Salesforce admin change requests (migration 161) — the stored half of the
 * confirm rule for building in a Salesforce org
 * (docs/salesforce-connectors-design.md, "Confirm rule: change requests,
 * applied in the browser"); lib/jira-admin/change-requests.ts's shape.
 *
 * A `salesforce_admin_propose_*` tool writes a row here — the deployment it
 * built, and what Salesforce's check-only deploy said of it — and changes
 * nothing in the org. The owner applies it from a signed-in browser
 * session (app/api/salesforce-admin/changes/[changeId]/apply), and only the
 * owner: every read and write is scoped by subject, so someone else's
 * request is "not found", never an existence oracle.
 *
 * Read from the clock rather than stored: a pending row past `expires_at`
 * is 'expired'. Unlike Jira's, an 'applying' row is rarely lost: the deploy
 * runs in Salesforce whatever happens to the request that started it, and
 * its id is recorded before anything else (`recordDeployStarted`), so a
 * later look reads the deploy's own status and finishes the row
 * (apply.ts, `refreshApplying`). Only an apply cut off before Salesforce
 * gave it an id reads as 'interrupted'.
 */

import { sql, type Kysely } from 'kysely';
import type { DB } from '@renkei/db';
import type { DeployFailure, DeployOutcome } from '@renkei/connector-salesforce';
import { isUuid } from '@/lib/uuid';

/** How long a proposal can wait for its review. */
export const CHANGE_REQUEST_TTL_HOURS = 24;

/** An apply that has held its claim this long, with no deploy started, was cut off. */
const INTERRUPTED_AFTER_MS = 10 * 60 * 1000;

export type ChangeRequestStatus =
  'pending' | 'queued' | 'applying' | 'applied' | 'partial' | 'failed' | 'cancelled';

/**
 * A free-text ask from someone who cannot build a package: nothing to
 * deploy, an operator turns it into a proposal or declines it.
 */
export const REQUEST_KIND = 'request';

/** A job that has not touched its row for this long lost its process. */
export const JOB_STALE_MS = 90 * 1000;

export type ChangeRequestState = ChangeRequestStatus | 'expired' | 'interrupted';

/** What one step of an apply did. */
export interface OperationResult {
  label: string;
  outcome: 'done' | 'failed' | 'not_run';
  detail?: string;
}

/** What Salesforce's check-only deploy said, or why it could not run. */
export type Validation =
  | {
      deployId: string;
      done: boolean;
      success: boolean;
      status: string;
      failures: DeployFailure[];
      errorMessage?: string;
      checkedAt: string;
    }
  | { error: string; checkedAt: string };

export interface ApplyResults {
  /** The real deploy, once Salesforce gave it an id. */
  deployId?: string;
  /** Whether it reused the validation (a quick deploy). */
  quick?: boolean;
  operations: OperationResult[];
}

export interface ChangeRequest {
  id: string;
  subject: string;
  agentId: string | null;
  /** The admin connector (org) it was built for. */
  connectorKey: string;
  orgId: string;
  instanceUrl: string;
  kind: string;
  title: string;
  reason: string | null;
  /** Shaped by `kind` — each kind's module reads its own. */
  payload: unknown;
  validation: Validation | null;
  status: ChangeRequestStatus;
  results: ApplyResults | null;
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
  // The CHECK constraint holds it to this list; anything else reads as
  // failed, never as pending.
  return STATUSES.find((status) => status === value) ?? 'failed';
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : {};
}

function operationsOf(value: unknown): OperationResult[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item: unknown): OperationResult[] => {
    const entry = record(item);
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

function resultsOf(value: unknown): ApplyResults | null {
  if (value === null || value === undefined) return null;
  const entry = record(value);
  return {
    ...(typeof entry.deployId === 'string' ? { deployId: entry.deployId } : {}),
    ...(entry.quick === true ? { quick: true } : {}),
    operations: operationsOf(entry.operations),
  };
}

function failuresOf(value: unknown): DeployFailure[] {
  if (!Array.isArray(value)) return [];
  return value.map((item: unknown) => {
    const entry = record(item);
    return {
      type: typeof entry.type === 'string' ? entry.type : '',
      name: typeof entry.name === 'string' ? entry.name : '',
      problem: typeof entry.problem === 'string' ? entry.problem : '',
      ...(typeof entry.line === 'number' ? { line: entry.line } : {}),
    };
  });
}

function validationOf(value: unknown): Validation | null {
  if (value === null || value === undefined) return null;
  const entry = record(value);
  const checkedAt = typeof entry.checkedAt === 'string' ? entry.checkedAt : '';
  if (typeof entry.error === 'string') return { error: entry.error, checkedAt };
  return {
    deployId: typeof entry.deployId === 'string' ? entry.deployId : '',
    done: entry.done === true,
    success: entry.success === true,
    status: typeof entry.status === 'string' ? entry.status : '',
    failures: failuresOf(entry.failures),
    ...(typeof entry.errorMessage === 'string' ? { errorMessage: entry.errorMessage } : {}),
    checkedAt,
  };
}

/** A check-only deploy's outcome, as stored. */
export function validationFrom(outcome: DeployOutcome, now = new Date()): Validation {
  return {
    deployId: outcome.id,
    done: outcome.done,
    success: outcome.success,
    status: outcome.status,
    failures: outcome.failures,
    ...(outcome.errorMessage ? { errorMessage: outcome.errorMessage } : {}),
    checkedAt: now.toISOString(),
  };
}

/** Whether the validation passed — the only state a request may be applied in. */
export function validationPassed(validation: Validation | null): boolean {
  return validation !== null && 'deployId' in validation && validation.done && validation.success;
}

type Row = {
  id: string;
  subject: string;
  agent_id: string | null;
  connector_key: string;
  org_id: string;
  instance_url: string;
  kind: string;
  title: string;
  reason: string | null;
  payload: unknown;
  validation: unknown;
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
    connectorKey: row.connector_key,
    orgId: row.org_id,
    instanceUrl: row.instance_url,
    kind: row.kind,
    title: row.title,
    reason: row.reason,
    payload: row.payload,
    validation: validationOf(row.validation),
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
  'connector_key',
  'org_id',
  'instance_url',
  'kind',
  'title',
  'reason',
  'payload',
  'validation',
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

const TABLE = 'salesforce_admin_change_requests';

export function stateOf(
  change: Pick<ChangeRequest, 'status' | 'expiresAt' | 'updatedAt' | 'results'>,
  now: Date = new Date()
): ChangeRequestState {
  if (change.status === 'pending' && change.expiresAt.getTime() <= now.getTime()) return 'expired';
  if (
    change.status === 'applying' &&
    !change.results?.deployId &&
    now.getTime() - change.updatedAt.getTime() > INTERRUPTED_AFTER_MS
  ) {
    return 'interrupted';
  }
  return change.status;
}

export async function createChangeRequest(
  db: Kysely<DB>,
  input: {
    subject: string;
    agentId?: string;
    connectorKey: string;
    orgId: string;
    instanceUrl: string;
    kind: string;
    title: string;
    reason?: string;
    payload: unknown;
  }
): Promise<ChangeRequest> {
  const row = await db
    .insertInto(TABLE)
    .values({
      subject: input.subject,
      agent_id: input.agentId && isUuid(input.agentId) ? input.agentId : null,
      connector_key: input.connectorKey,
      org_id: input.orgId,
      instance_url: input.instanceUrl,
      kind: input.kind,
      title: input.title.slice(0, 300),
      reason: input.reason?.trim() ? input.reason.trim() : null,
      payload: JSON.stringify(input.payload),
      expires_at: sql<Date>`NOW() + (${CHANGE_REQUEST_TTL_HOURS} * INTERVAL '1 hour')`,
    })
    .returning(COLUMNS)
    .executeTakeFirstOrThrow();
  return fromRow(row);
}

/** Store what the check-only deploy said (on proposing, or when a page looks again). */
export async function setValidation(
  db: Kysely<DB>,
  id: string,
  validation: Validation
): Promise<void> {
  await db
    .updateTable(TABLE)
    .set({ validation: JSON.stringify(validation), updated_at: sql<Date>`NOW()` })
    .where('id', '=', id)
    .execute();
}

/** One of this person's requests, or null — someone else's reads the same as none. */
export async function getChangeRequest(
  db: Kysely<DB>,
  subject: string,
  id: string
): Promise<ChangeRequest | null> {
  if (!isUuid(id)) return null;
  const row = await db
    .selectFrom(TABLE)
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
  options: { limit?: number; pendingOnly?: boolean; connectorKey?: string } = {}
): Promise<ChangeRequest[]> {
  let query = db.selectFrom(TABLE).select(COLUMNS).where('subject', '=', subject);
  if (options.pendingOnly) {
    query = query.where('status', '=', 'pending').where('expires_at', '>', sql<Date>`NOW()`);
  }
  if (options.connectorKey) query = query.where('connector_key', '=', options.connectorKey);
  const rows = await query
    .orderBy('created_at', 'desc')
    .limit(options.limit ?? 50)
    .execute();
  return rows.map(fromRow);
}

/** How many of this person's requests wait for them, per connector, for the cards. */
export async function countPendingChangeRequests(
  db: Kysely<DB>,
  subject: string
): Promise<Map<string, number>> {
  const rows = await db
    .selectFrom(TABLE)
    .select(['connector_key', (eb) => eb.fn.countAll<string>().as('count')])
    .where('subject', '=', subject)
    .where('status', '=', 'pending')
    .where('expires_at', '>', sql<Date>`NOW()`)
    .groupBy('connector_key')
    .execute();
  return new Map(rows.map((row) => [row.connector_key, Number(row.count)]));
}

/**
 * Take the request for applying. A conditional update, so of two clicks
 * exactly one wins; the loser, like an expired or decided request, gets false.
 */
export async function claimChangeRequest(
  db: Kysely<DB>,
  subject: string,
  id: string
): Promise<boolean> {
  if (!isUuid(id)) return false;
  const result = await db
    .updateTable(TABLE)
    .set({ status: 'applying', updated_at: sql<Date>`NOW()` })
    .where('id', '=', id)
    .where('subject', '=', subject)
    .where('status', '=', 'pending')
    .where('expires_at', '>', sql<Date>`NOW()`)
    .executeTakeFirst();
  return Number(result.numUpdatedRows ?? 0) > 0;
}

/** Note the real deploy's id as soon as Salesforce gives one, so a lost request can be finished. */
export async function recordDeployStarted(
  db: Kysely<DB>,
  id: string,
  results: ApplyResults
): Promise<void> {
  await db
    .updateTable(TABLE)
    .set({ results: JSON.stringify(results), updated_at: sql<Date>`NOW()` })
    .where('id', '=', id)
    .where('status', '=', 'applying')
    .execute();
}

/** Record how an apply ended. Only the claim's holder (or a refresh of its deploy) gets here. */
export async function finishChangeRequest(
  db: Kysely<DB>,
  id: string,
  outcome: {
    status: 'applied' | 'partial' | 'failed';
    results: ApplyResults;
    appliedBy: string;
  }
): Promise<boolean> {
  const result = await db
    .updateTable(TABLE)
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
    .executeTakeFirst();
  return Number(result.numUpdatedRows ?? 0) > 0;
}

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

/** How many requests are waiting for an operator, per connector, for the cards and the nav. */
export async function countAwaitingReview(db: Kysely<DB>): Promise<Map<string, number>> {
  const rows = await db
    .selectFrom(TABLE)
    .select(['connector_key', (eb) => eb.fn.countAll<string>().as('count')])
    .where('status', '=', 'pending')
    .where('expires_at', '>', sql<Date>`NOW()`)
    .groupBy('connector_key')
    .execute();
  return new Map(rows.map((row) => [row.connector_key, Number(row.count)]));
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

/** Say what the job is doing, which is also its heartbeat. */
export async function setStep(db: Kysely<DB>, id: string, step: string): Promise<void> {
  await db
    .updateTable(TABLE)
    .set({ step: step.slice(0, 500), updated_at: sql<Date>`NOW()` })
    .where('id', '=', id)
    .where('status', 'in', ['queued', 'applying'])
    .execute();
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

/** File a free-text request: no package, no validation, just words for an operator. */
export async function createRequest(
  db: Kysely<DB>,
  input: {
    subject: string;
    agentId?: string;
    connectorKey: string;
    orgId: string;
    instanceUrl: string;
    title: string;
    reason?: string;
    description: string;
  }
): Promise<ChangeRequest> {
  const request = await createChangeRequest(db, {
    subject: input.subject,
    agentId: input.agentId,
    connectorKey: input.connectorKey,
    orgId: input.orgId,
    instanceUrl: input.instanceUrl,
    kind: REQUEST_KIND,
    title: input.title,
    reason: input.reason,
    payload: { description: input.description },
  });
  return request;
}

/** The words of a free-text request. */
export function requestDescription(payload: unknown): string {
  const value = record(payload).description;
  return typeof value === 'string' ? value : '';
}
