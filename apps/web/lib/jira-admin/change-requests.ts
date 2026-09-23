/**
 * Jira admin change requests (migration 120) — the stored half of the
 * confirm rule for Jira administration
 * (docs/project-management-design.md).
 *
 * A `jira_admin_propose_*` tool writes a row here and changes nothing in
 * Jira. The owner applies it from a signed-in browser session
 * (app/api/tenant/[tenantId]/jira-admin/changes/[changeId]/apply), and only
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

/** How long a proposal can wait for its review. */
export const CHANGE_REQUEST_TTL_HOURS = 24;

/** An apply that has held its claim this long without finishing was cut off. */
const INTERRUPTED_AFTER_MS = 10 * 60 * 1000;

export type ChangeRequestStatus =
  'pending' | 'applying' | 'applied' | 'partial' | 'failed' | 'cancelled';

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
}

const STATUSES: readonly ChangeRequestStatus[] = [
  'pending',
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
] as const;

export function stateOf(
  change: Pick<ChangeRequest, 'status' | 'expiresAt' | 'updatedAt'>,
  now: Date = new Date()
): ChangeRequestState {
  if (change.status === 'pending' && change.expiresAt.getTime() <= now.getTime()) return 'expired';
  if (
    change.status === 'applying' &&
    now.getTime() - change.updatedAt.getTime() > INTERRUPTED_AFTER_MS
  ) {
    return 'interrupted';
  }
  return change.status;
}

export async function createChangeRequest(
  db: Kysely<DB>,
  input: {
    tenantId: string;
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
      tenant_id: input.tenantId,
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
  return fromRow(row);
}

/** One of this person's requests, or null — someone else's reads the same as none. */
export async function getChangeRequest(
  db: Kysely<DB>,
  tenantId: string,
  subject: string,
  id: string
): Promise<ChangeRequest | null> {
  if (!isUuid(id)) return null;
  const row = await db
    .selectFrom('jira_admin_change_requests')
    .select(COLUMNS)
    .where('id', '=', id)
    .where('tenant_id', '=', tenantId)
    .where('subject', '=', subject)
    .executeTakeFirst();
  return row ? fromRow(row) : null;
}

/** This person's requests, newest first; `pendingOnly` leaves out expired ones too. */
export async function listChangeRequests(
  db: Kysely<DB>,
  tenantId: string,
  subject: string,
  options: { limit?: number; pendingOnly?: boolean } = {}
): Promise<ChangeRequest[]> {
  let query = db
    .selectFrom('jira_admin_change_requests')
    .select(COLUMNS)
    .where('tenant_id', '=', tenantId)
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
export async function countPendingChangeRequests(
  db: Kysely<DB>,
  tenantId: string,
  subject: string
): Promise<number> {
  const row = await db
    .selectFrom('jira_admin_change_requests')
    .select((eb) => eb.fn.countAll<string>().as('count'))
    .where('tenant_id', '=', tenantId)
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
  tenantId: string,
  subject: string,
  id: string
): Promise<boolean> {
  if (!isUuid(id)) return false;
  const result = await db
    .updateTable('jira_admin_change_requests')
    .set({ status: 'applying', updated_at: sql<Date>`NOW()` })
    .where('id', '=', id)
    .where('tenant_id', '=', tenantId)
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
    })
    .where('id', '=', id)
    .where('status', '=', 'applying')
    .execute();
}

/** Withdraw a pending request. False when it is not this person's, or no longer pending. */
export async function cancelChangeRequest(
  db: Kysely<DB>,
  tenantId: string,
  subject: string,
  id: string
): Promise<boolean> {
  if (!isUuid(id)) return false;
  const result = await db
    .updateTable('jira_admin_change_requests')
    .set({
      status: 'cancelled',
      cancelled_at: sql<Date>`NOW()`,
      updated_at: sql<Date>`NOW()`,
    })
    .where('id', '=', id)
    .where('tenant_id', '=', tenantId)
    .where('subject', '=', subject)
    .where('status', '=', 'pending')
    .executeTakeFirst();
  return Number(result.numUpdatedRows ?? 0) > 0;
}
