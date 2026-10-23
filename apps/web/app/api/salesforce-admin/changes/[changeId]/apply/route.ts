/**
 * Apply a Salesforce admin change request — the only way one ever reaches
 * the org (docs/salesforce-connectors-design.md, "Confirm rule: change
 * requests, applied in the browser").
 *
 * A browser session, never an MCP token: this is the click the confirm
 * rule is about. Only the request's owner, on their own admin grant to the
 * org it was built for, and only while the org would still let them
 * propose it and Salesforce's validation passed (applyGate). What deploys
 * comes from the stored row — the body is ignored — so it is exactly what
 * the review page showed and Salesforce validated.
 *
 * A deploy still running when this request's wait ends answers 202 and
 * stays 'applying'; the review page finishes it when it looks again.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getDatabase } from '@renkei/db';
import { getSessionFromRequest } from '@/lib/session';
import { recordAuditEvent } from '@/lib/audit-events';
import { logger } from '@/lib/logger';
import {
  claimChangeRequest,
  finishChangeRequest,
  getChangeRequest,
  stateOf,
  type ApplyResults,
  type ChangeRequestStatus,
} from '@/lib/salesforce-admin/change-requests';
import { accessForChange, applyChangeRequest, applyGate } from '@/lib/salesforce-admin/apply';

const NOT_PENDING: Record<string, string> = {
  applying: 'This change request is already being applied.',
  applied: 'This change request has already been applied.',
  partial: 'This change request has already been applied, in part.',
  failed: 'This change request was already tried, and failed.',
  cancelled: 'This change request was cancelled.',
  expired: 'This change request has expired. Ask for the change again to get a fresh one.',
  interrupted:
    'This change request was interrupted before Salesforce started its deploy; nothing was deployed.',
};

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ changeId: string }> }
): Promise<NextResponse> {
  const { changeId } = await params;

  const session = await getSessionFromRequest(request);
  if (!session) {
    return NextResponse.json({ error: 'Not signed in' }, { status: 401 });
  }

  const dbResult = getDatabase();
  if (!dbResult.ok) {
    return NextResponse.json({ error: 'Database error' }, { status: 500 });
  }
  const db = dbResult.val;

  // Owner-scoped: someone else's request is not found, not forbidden.
  const change = await getChangeRequest(db, session.subject, changeId);
  if (!change) {
    return NextResponse.json({ error: 'Change request not found' }, { status: 404 });
  }
  const state = stateOf(change);
  if (state !== 'pending') {
    return NextResponse.json({ error: NOT_PENDING[state] ?? 'Not pending' }, { status: 409 });
  }

  const gate = await applyGate(db, session.subject, session.roles, change);
  if (!gate.ok) {
    return NextResponse.json({ error: gate.reason }, { status: 403 });
  }

  const context = { subject: session.subject, db };
  const access = await accessForChange(context, change);
  if (typeof access === 'string') {
    return NextResponse.json({ error: access }, { status: 409 });
  }

  // Claim before running, so two clicks cannot both apply it.
  if (!(await claimChangeRequest(db, session.subject, change.id))) {
    return NextResponse.json(
      { error: 'This change request is no longer pending.' },
      { status: 409 }
    );
  }

  let outcome: { status: ChangeRequestStatus; results: ApplyResults };
  try {
    outcome = await applyChangeRequest(db, context, access, change, session.subject);
  } catch (error) {
    logger.error('salesforce admin change apply threw', {
      component: 'salesforce-admin/apply',
      subject: session.subject,
      changeId: change.id,
      error: error instanceof Error ? error.message : String(error),
    });
    const fresh = await getChangeRequest(db, session.subject, change.id);
    if (fresh?.results?.deployId) {
      // The deploy started; the review page reads how it ended.
      return NextResponse.json({ status: 'applying', results: fresh.results }, { status: 202 });
    }
    outcome = {
      status: 'failed',
      results: {
        operations: [
          {
            label: 'Apply the change request',
            outcome: 'failed',
            detail:
              'Something went wrong before Salesforce started a deploy; nothing was deployed.',
          },
        ],
      },
    };
    await finishChangeRequest(db, change.id, {
      status: 'failed',
      results: outcome.results,
      appliedBy: session.subject,
    });
  }

  recordAuditEvent({
    actorSubject: session.subject,
    action: 'salesforce_admin.change_applied',
    targetKind: 'salesforce_admin_change',
    targetLabel: change.title,
    details: {
      changeId: change.id,
      kind: change.kind,
      status: outcome.status,
      connector: change.connectorKey,
      orgId: change.orgId,
      deployId: outcome.results.deployId ?? null,
      quick: outcome.results.quick === true,
      ...(change.agentId ? { proposedByAgent: change.agentId } : {}),
    },
  });

  return NextResponse.json(
    { status: outcome.status, results: outcome.results },
    { status: outcome.status === 'applying' ? 202 : 200 }
  );
}
