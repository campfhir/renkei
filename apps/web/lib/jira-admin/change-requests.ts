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

import { getDataStore, type JiraChangeRecord } from '@renkei/db';
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

function fromRecord(row: JiraChangeRecord): ChangeRequest {
  return {
    ...row,
    status: statusOf(row.status),
    results: resultsOf(row.results),
  };
}

const changes = () => getDataStore().jiraChanges;

/** Shown while a job has the change but has not started on it. */
const QUEUED_STEP = 'Waiting to start';
const STARTING_STEP = 'Starting';

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

export async function createChangeRequest(input: {
  subject: string;
  agentId?: string;
  cloudId: string;
  siteUrl?: string;
  kind: string;
  title: string;
  reason?: string;
  payload: unknown;
}): Promise<ChangeRequest> {
  const row = await changes().create({
    subject: input.subject,
    agentId: input.agentId && isUuid(input.agentId) ? input.agentId : null,
    cloudId: input.cloudId,
    siteUrl: input.siteUrl || null,
    kind: input.kind,
    title: input.title.slice(0, 300),
    reason: input.reason?.trim() ? input.reason.trim() : null,
    payload: input.payload,
    ttlHours: CHANGE_REQUEST_TTL_HOURS,
  });
  const change = fromRecord(row);
  // Every proposal tool files through here, so this is the one place that
  // tells the people who approve that something is waiting.
  notifyOperatorsOfRequest({
    connector: 'jira-admin',
    changeId: change.id,
    title: change.title,
    requester: change.subject,
    freeText: change.kind === REQUEST_KIND,
  });
  return change;
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
  options: { limit?: number; pendingOnly?: boolean } = {}
): Promise<ChangeRequest[]> {
  const rows = await changes().list({
    subject,
    limit: options.limit ?? 50,
    pendingOnly: options.pendingOnly,
  });
  return rows.map(fromRecord);
}

/** How many of this person's requests are waiting for them, for the connector card. */
export async function countPendingChangeRequests(subject: string): Promise<number> {
  return changes().countPending({ subject });
}

/**
 * Take the request for applying. A conditional update, so of two clicks
 * exactly one wins; the loser, like an expired or decided request, gets false.
 */
export async function claimChangeRequest(subject: string, id: string): Promise<boolean> {
  if (!isUuid(id)) return false;
  return changes().claim(subject, id);
}

/** Record how an apply ended. Only the claim's holder gets here. */
export async function finishChangeRequest(
  id: string,
  outcome: {
    status: 'applied' | 'partial' | 'failed';
    results: OperationResult[];
    appliedBy: string;
  }
): Promise<void> {
  await changes().finish(id, outcome);
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

/** How many requests wait for an operator, for the connector card. */
export async function countAwaitingReview(): Promise<number> {
  return changes().countPending();
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

/**
 * Say what the job is doing, which is also its heartbeat. False once the
 * request is no longer queued or applying.
 */
export async function setStep(id: string, step: string): Promise<boolean> {
  return changes().setStep(id, step.slice(0, 500));
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

/** File a free-text request: no operations, just words for an operator. */
export async function createRequest(input: {
  subject: string;
  agentId?: string;
  cloudId: string;
  siteUrl?: string;
  title: string;
  reason?: string;
  description: string;
}): Promise<ChangeRequest> {
  return createChangeRequest({
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
