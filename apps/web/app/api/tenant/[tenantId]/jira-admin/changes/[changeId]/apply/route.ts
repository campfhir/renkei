/**
 * Apply a Jira admin change request — the only way one ever reaches Jira
 * (docs/project-management-design.md, "The confirm rule").
 *
 * A browser session, never an MCP token: this is the click the confirm
 * rule is about, and no MCP host can prove a click was a person's. Only
 * the request's owner, on their own Jira Administration grant, and only
 * while the org would still let them propose it (applyGate). The
 * operations come from the stored row — the body is ignored — so what runs
 * is exactly what the review page showed.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getDatabase } from '@renkei/db';
import { getSessionFromRequest } from '@/lib/session';
import { getOrigin } from '@/lib/get-origin';
import { recordAuditEvent } from '@/lib/audit-events';
import { logger } from '@/lib/logger';
import { resolveJiraAdminAccess } from '@/lib/mcp-tools/jira-admin/client';
import {
  claimChangeRequest,
  finishChangeRequest,
  getChangeRequest,
  stateOf,
  type OperationResult,
} from '@/lib/jira-admin/change-requests';
import { applyChangeRequest, applyGate } from '@/lib/jira-admin/apply';

const NOT_PENDING: Record<string, string> = {
  applying: 'This change request is already being applied.',
  applied: 'This change request has already been applied.',
  partial: 'This change request has already been applied, in part.',
  failed: 'This change request was already tried, and failed.',
  cancelled: 'This change request was cancelled.',
  expired: 'This change request has expired. Ask for the change again to get a fresh one.',
  interrupted: 'This change request was interrupted while applying; check Jira.',
};

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ tenantId: string; changeId: string }> }
): Promise<NextResponse> {
  const { tenantId, changeId } = await params;

  const session = await getSessionFromRequest(request, tenantId);
  if (!session) {
    return NextResponse.json({ error: 'Not signed in' }, { status: 401 });
  }

  const dbResult = getDatabase();
  if (!dbResult.ok) {
    return NextResponse.json({ error: 'Database error' }, { status: 500 });
  }
  const db = dbResult.val;

  // Owner-scoped: someone else's request is not found, not forbidden.
  const change = await getChangeRequest(db, tenantId, session.subject, changeId);
  if (!change) {
    return NextResponse.json({ error: 'Change request not found' }, { status: 404 });
  }
  const state = stateOf(change);
  if (state !== 'pending') {
    return NextResponse.json({ error: NOT_PENDING[state] ?? 'Not pending' }, { status: 409 });
  }

  const gate = await applyGate(db, tenantId, session.subject, session.roles, change.kind);
  if (!gate.ok) {
    return NextResponse.json({ error: gate.reason }, { status: 403 });
  }

  const originResult = await getOrigin(request);
  const access = await resolveJiraAdminAccess({
    tenantId,
    subject: session.subject,
    origin: originResult.ok ? originResult.val : undefined,
  });
  if (typeof access === 'string') {
    return NextResponse.json({ error: access }, { status: 409 });
  }
  if (access.cloudId !== change.cloudId) {
    // Reconnecting to another site must not redirect an old proposal there.
    return NextResponse.json(
      {
        error:
          'Your Jira Administration connection is on a different Jira site than the one this ' +
          'change was proposed for, so it was not applied.',
      },
      { status: 409 }
    );
  }

  // Claim before running, so two clicks cannot both apply it.
  if (!(await claimChangeRequest(db, tenantId, session.subject, change.id))) {
    return NextResponse.json(
      { error: 'This change request is no longer pending.' },
      { status: 409 }
    );
  }

  let outcome: { status: 'applied' | 'partial' | 'failed'; results: OperationResult[] };
  try {
    outcome = await applyChangeRequest({ tenantId, subject: session.subject }, access, change);
  } catch (error) {
    logger.error('jira admin change apply threw', {
      component: 'jira-admin/apply',
      tenantId,
      subject: session.subject,
      changeId: change.id,
      error: error instanceof Error ? error.message : String(error),
    });
    outcome = {
      status: 'failed',
      results: [
        {
          label: 'Apply the change request',
          outcome: 'failed',
          detail: 'Something went wrong partway; check Jira for what reached it.',
        },
      ],
    };
  }

  await finishChangeRequest(db, change.id, { ...outcome, appliedBy: session.subject });

  const done = outcome.results.filter((result) => result.outcome === 'done').length;
  recordAuditEvent({
    tenantId,
    actorSubject: session.subject,
    action: 'jira_admin.change_applied',
    targetKind: 'jira_admin_change',
    targetLabel: change.title,
    details: {
      changeId: change.id,
      kind: change.kind,
      status: outcome.status,
      operations: outcome.results.length,
      done,
      site: change.siteUrl ?? change.cloudId,
      ...(change.agentId ? { proposedByAgent: change.agentId } : {}),
    },
  });

  return NextResponse.json({ status: outcome.status, results: outcome.results });
}
