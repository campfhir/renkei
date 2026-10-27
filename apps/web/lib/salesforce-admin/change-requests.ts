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

import { getDataStore, type SalesforceChangeRecord } from '@renkei/db';
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

function fromRecord(row: SalesforceChangeRecord): ChangeRequest {
  return {
    ...row,
    validation: validationOf(row.validation),
    status: statusOf(row.status),
    results: resultsOf(row.results),
  };
}

const changes = () => getDataStore().salesforceChanges;

/** Shown while a job has the change but has not started on it. */
const QUEUED_STEP = 'Waiting to start';
const STARTING_STEP = 'Starting';

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

export async function createChangeRequest(input: {
  subject: string;
  agentId?: string;
  connectorKey: string;
  orgId: string;
  instanceUrl: string;
  kind: string;
  title: string;
  reason?: string;
  payload: unknown;
}): Promise<ChangeRequest> {
  const row = await changes().create({
    subject: input.subject,
    agentId: input.agentId && isUuid(input.agentId) ? input.agentId : null,
    connectorKey: input.connectorKey,
    orgId: input.orgId,
    instanceUrl: input.instanceUrl,
    kind: input.kind,
    title: input.title.slice(0, 300),
    reason: input.reason?.trim() ? input.reason.trim() : null,
    payload: input.payload,
    ttlHours: CHANGE_REQUEST_TTL_HOURS,
  });
  return fromRecord(row);
}

/** Store what the check-only deploy said (on proposing, or when a page looks again). */
export async function setValidation(id: string, validation: Validation): Promise<void> {
  await changes().setValidation(id, validation);
}

/** One of this person's requests, or null — someone else's reads the same as none. */
export async function getChangeRequest(subject: string, id: string): Promise<ChangeRequest | null> {
  if (!isUuid(id)) return null;
  const row = await changes().get(id, { subject });
  return row ? fromRecord(row) : null;
}

/** This person's requests, newest first; `pendingOnly` leaves out expired ones too. */
export async function listChangeRequests(
  subject: string,
  options: { limit?: number; pendingOnly?: boolean; connectorKey?: string } = {}
): Promise<ChangeRequest[]> {
  const rows = await changes().list({
    subject,
    limit: options.limit ?? 50,
    pendingOnly: options.pendingOnly,
    connectorKey: options.connectorKey,
  });
  return rows.map(fromRecord);
}

function byConnector(rows: { connectorKey: string; count: number }[]): Map<string, number> {
  return new Map(rows.map((row) => [row.connectorKey, row.count]));
}

/** How many of this person's requests wait for them, per connector, for the cards. */
export async function countPendingChangeRequests(subject: string): Promise<Map<string, number>> {
  return byConnector(await changes().countPendingByConnector({ subject }));
}

/**
 * Take the request for applying. A conditional update, so of two clicks
 * exactly one wins; the loser, like an expired or decided request, gets false.
 */
export async function claimChangeRequest(subject: string, id: string): Promise<boolean> {
  if (!isUuid(id)) return false;
  return changes().claim(subject, id);
}

/** Note the real deploy's id as soon as Salesforce gives one, so a lost request can be finished. */
export async function recordDeployStarted(id: string, results: ApplyResults): Promise<void> {
  await changes().recordDeployStarted(id, results);
}

/** Record how an apply ended. Only the claim's holder (or a refresh of its deploy) gets here. */
export async function finishChangeRequest(
  id: string,
  outcome: {
    status: 'applied' | 'partial' | 'failed';
    results: ApplyResults;
    appliedBy: string;
  }
): Promise<boolean> {
  return changes().finish(id, outcome);
}

/**
 * Withdraw a pending request. The requester may withdraw their own; an
 * operator (`operator: true`) may decline anyone's, with a note the
 * requester reads. False when it is not theirs to cancel, or no longer pending.
 */
export async function cancelChangeRequest(
  subject: string,
  id: string,
  options: { operator?: boolean; note?: string } = {}
): Promise<boolean> {
  if (!isUuid(id)) return false;
  return changes().cancel(id, {
    ...(options.operator ? {} : { subject }),
    ...(options.note?.trim() ? { resolution: options.note.trim().slice(0, 2000) } : {}),
  });
}

/** One request by id, whoever owns it. The caller decides who may see it (`mayView`). */
export async function getChangeRequestById(id: string): Promise<ChangeRequest | null> {
  if (!isUuid(id)) return null;
  const row = await changes().get(id);
  return row ? fromRecord(row) : null;
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
  options: { limit?: number } = {}
): Promise<ChangeRequest[]> {
  const rows = await changes().list({ limit: options.limit ?? 100 });
  return rows.map(fromRecord);
}

/** How many requests are waiting for an operator, per connector, for the cards and the nav. */
export async function countAwaitingReview(): Promise<Map<string, number>> {
  return byConnector(await changes().countPendingByConnector());
}

/**
 * Approve: hand a pending request to the job queue, on this operator's
 * connection. A conditional update, so two approvals cannot both queue it.
 */
export async function queueChangeRequest(id: string, approver: string): Promise<boolean> {
  if (!isUuid(id)) return false;
  return changes().queue(id, {
    approvedBy: approver,
    step: QUEUED_STEP,
    exceptKind: REQUEST_KIND,
  });
}

/** The job takes a queued request. Of two processes, exactly one wins. */
export async function startQueuedChange(id: string): Promise<boolean> {
  if (!isUuid(id)) return false;
  return changes().startQueued(id, STARTING_STEP);
}

/**
 * Take over an 'applying' request whose job stopped touching it (its
 * process died). A conditional update on the heartbeat, so of two sweeps
 * exactly one takes it.
 */
export async function reclaimStaleChange(
  id: string,
  staleMs: number = JOB_STALE_MS
): Promise<boolean> {
  if (!isUuid(id)) return false;
  return changes().reclaimStale(id, staleMs);
}

/** Say what the job is doing, which is also its heartbeat. */
export async function setStep(id: string, step: string): Promise<void> {
  await changes().setStep(id, step.slice(0, 500));
}

/** Ids the job sweep should look at: queued, or applying with a dead job. */
export async function listRunnableChanges(
  staleMs: number = JOB_STALE_MS,
  limit = 5
): Promise<{ id: string; status: 'queued' | 'applying' }[]> {
  return changes().listRunnable(staleMs, limit);
}

/** An operator built a free-text request into a proposal: close it, saying so. */
export async function closeRequestAsProposed(
  requestId: string,
  proposalId: string
): Promise<boolean> {
  if (!isUuid(requestId)) return false;
  return changes().closeAsProposed(requestId, {
    kind: REQUEST_KIND,
    resolution: `An operator turned this into a proposal (${proposalId}).`,
  });
}

/** File a free-text request: no package, no validation, just words for an operator. */
export async function createRequest(input: {
  subject: string;
  agentId?: string;
  connectorKey: string;
  orgId: string;
  instanceUrl: string;
  title: string;
  reason?: string;
  description: string;
}): Promise<ChangeRequest> {
  return createChangeRequest({
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
}

/** The words of a free-text request. */
export function requestDescription(payload: unknown): string {
  const value = record(payload).description;
  return typeof value === 'string' ? value : '';
}
