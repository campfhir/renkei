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

import { getDataStore, type SizeRequestRecord } from '@renkei/db';
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

function toView(row: SizeRequestRecord, projectName: string | null): SizeRequestView {
  return {
    id: row.id,
    projectId: row.subject.startsWith(PROJECT_PREFIX)
      ? row.subject.slice(PROJECT_PREFIX.length)
      : row.subject,
    projectName: projectName ?? 'Deleted project',
    requestedBy: row.requestedBy,
    requestedBytes: row.requestedBytes,
    reason: row.reason,
    status: statusOf(row.status),
    decidedBy: row.decidedBy,
    decidedAt: row.decidedAt ? row.decidedAt.toISOString() : null,
    decisionNote: row.decisionNote,
    createdAt: row.createdAt.toISOString(),
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
export async function latestSizeRequest(projectId: string): Promise<SizeRequestView | null> {
  const row = await getDataStore().codeProjects.latestSizeRequest(
    codeProjectTarget(projectId).subject
  );
  return row ? toView(row, null) : null;
}

/** File a request; null when one is already waiting for this project. */
export async function createSizeRequest(input: {
  projectId: string;
  projectName: string;
  requestedBy: string;
  requestedBytes: number;
  reason: string;
}): Promise<SizeRequestView | null> {
  const row = await getDataStore().codeProjects.createSizeRequest({
    subject: codeProjectTarget(input.projectId).subject,
    requestedBy: input.requestedBy,
    requestedBytes: input.requestedBytes,
    reason: input.reason,
  });
  return row ? toView(row, input.projectName) : null;
}

/** The org's requests, pending first then newest, for the admin page. */
export async function listSizeRequests(limit = 100): Promise<SizeRequestView[]> {
  const rows = await getDataStore().codeProjects.listSizeRequests(PROJECT_PREFIX, limit);
  return rows.map((row) => toView(row, row.projectName));
}

export type DecideOutcome = { ok: true; request: SizeRequestView } | { ok: false; reason: 'gone' };

/** Decide a pending request; `approvedBytes` may differ from what was asked. */
export async function decideSizeRequest(input: {
  id: string;
  decision: 'approved' | 'denied';
  decidedBy: string;
  note: string | null;
  approvedBytes?: number;
}): Promise<DecideOutcome> {
  const row = await getDataStore().codeProjects.decideSizeRequest({
    id: input.id,
    status: input.decision,
    decidedBy: input.decidedBy,
    note: input.note,
    ...(input.approvedBytes !== undefined ? { approvedBytes: input.approvedBytes } : {}),
  });
  return row ? { ok: true, request: toView(row, null) } : { ok: false, reason: 'gone' };
}
