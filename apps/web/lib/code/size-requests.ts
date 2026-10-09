/**
 * Requests for a larger code-workspace checkout than the org's limit
 * (sandboxWorkspaceMaxBytes), and the admin's decision on each.
 *
 * A request belongs to a code project — the worker's subject for its
 * checkout is `code-project:<id>` (./scope.ts) — and an approved one
 * raises that checkout's limit and nothing else; `getWorkspaceLimitBytes`
 * (@renkei/settings) is what the worker consults. One request may be
 * pending per project, so a second click while the first waits is refused
 * rather than queued.
 */

import { sql, type Kysely } from 'kysely';
import type { DB } from '@renkei/db';
import {
  SIZE_REQUEST_REASON_MAX_CHARS,
  WORKSPACE_LIMIT_MAX_BYTES,
  WORKSPACE_LIMIT_MIN_BYTES,
} from '@renkei/connector-sandbox';
import { codeProjectTarget } from './scope';

export type SizeRequestStatus = 'pending' | 'approved' | 'denied';

export interface SizeRequestView {
  id: string;
  projectId: string;
  projectName: string;
  requestedBy: string;
  requestedBytes: number;
  reason: string;
  status: SizeRequestStatus;
  decidedBy: string | null;
  decidedAt: string | null;
  decisionNote: string | null;
  createdAt: string;
}

const PROJECT_PREFIX = 'code-project:';

function statusOf(value: string): SizeRequestStatus {
  return value === 'approved' || value === 'denied' ? value : 'pending';
}

function toView(row: {
  id: string;
  subject: string;
  requested_by: string;
  requested_bytes: string | number | bigint;
  reason: string;
  status: string;
  decided_by: string | null;
  decided_at: Date | null;
  decision_note: string | null;
  created_at: Date;
  project_name?: string | null;
}): SizeRequestView {
  return {
    id: row.id,
    projectId: row.subject.startsWith(PROJECT_PREFIX)
      ? row.subject.slice(PROJECT_PREFIX.length)
      : row.subject,
    projectName: row.project_name ?? 'Deleted project',
    requestedBy: row.requested_by,
    requestedBytes: Number(row.requested_bytes),
    reason: row.reason,
    status: statusOf(row.status),
    decidedBy: row.decided_by,
    decidedAt: row.decided_at ? new Date(row.decided_at).toISOString() : null,
    decisionNote: row.decision_note,
    createdAt: new Date(row.created_at).toISOString(),
  };
}

export function validRequestedBytes(value: unknown, orgLimitBytes: number): number | string {
  if (typeof value !== 'number' || !Number.isFinite(value))
    return 'requestedBytes must be a number';
  const bytes = Math.trunc(value);
  if (bytes > WORKSPACE_LIMIT_MAX_BYTES) {
    return `The most that can be requested is ${WORKSPACE_LIMIT_MAX_BYTES / 1_073_741_824} GB`;
  }
  if (bytes <= orgLimitBytes || bytes < WORKSPACE_LIMIT_MIN_BYTES) {
    return 'Ask for more than the current limit';
  }
  return bytes;
}

export function validReason(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const reason = value.trim();
  return reason.length > 0 && reason.length <= SIZE_REQUEST_REASON_MAX_CHARS ? reason : null;
}

/** This project's newest request, whatever its state, for its page. */
export async function latestSizeRequest(
  db: Kysely<DB>,
  tenantId: string,
  projectId: string
): Promise<SizeRequestView | null> {
  const row = await db
    .selectFrom('sandbox_size_requests')
    .selectAll()
    .where('subject', '=', codeProjectTarget(tenantId, projectId).subject)
    .orderBy('created_at', 'desc')
    .limit(1)
    .executeTakeFirst();
  return row ? toView(row) : null;
}

/** File a request; null when one is already waiting for this project. */
export async function createSizeRequest(
  db: Kysely<DB>,
  input: {
    projectId: string;
    projectName: string;
    requestedBy: string;
    requestedBytes: number;
    reason: string;
  }
): Promise<SizeRequestView | null> {
  const row = await db
    .insertInto('sandbox_size_requests')
    .values({
      subject: codeProjectTarget(input.tenantId, input.projectId).subject,
      requested_by: input.requestedBy,
      requested_bytes: input.requestedBytes,
      reason: input.reason,
    })
    .onConflict((oc) =>
      oc.columns(['subject']).where('status', '=', 'pending').doNothing()
    )
    .returningAll()
    .executeTakeFirst();
  return row ? toView({ ...row, project_name: input.projectName }) : null;
}

/** The org's requests, pending first then newest, for the admin page. */
export async function listSizeRequests(
  db: Kysely<DB>,
  tenantId: string,
  limit = 100
): Promise<SizeRequestView[]> {
  const rows = await db
    .selectFrom('sandbox_size_requests as r')
    .leftJoin('chat_projects as p', (join) =>
      join
        .on(sql<boolean>`r.subject = ${PROJECT_PREFIX} || p.id::text`)
    )
    .selectAll('r')
    .select('p.name as project_name')
    .orderBy((eb) => eb.case().when('r.status', '=', 'pending').then(0).else(1).end())
    .orderBy('r.created_at', 'desc')
    .limit(limit)
    .execute();
  return rows.map(toView);
}

export type DecideOutcome = { ok: true; request: SizeRequestView } | { ok: false; reason: 'gone' };

/** Decide a pending request; `approvedBytes` may differ from what was asked. */
export async function decideSizeRequest(
  db: Kysely<DB>,
  input: {
    id: string;
    decision: 'approved' | 'denied';
    decidedBy: string;
    note: string | null;
    approvedBytes?: number;
  }
): Promise<DecideOutcome> {
  const row = await db
    .updateTable('sandbox_size_requests')
    .set({
      status: input.decision,
      decided_by: input.decidedBy,
      decided_at: new Date().toISOString(),
      decision_note: input.note,
      ...(input.decision === 'approved' && input.approvedBytes !== undefined
        ? { requested_bytes: input.approvedBytes }
        : {}),
    })
    .where('id', '=', input.id)
    .where('status', '=', 'pending')
    .returningAll()
    .executeTakeFirst();
  return row ? { ok: true, request: toView(row) } : { ok: false, reason: 'gone' };
}
