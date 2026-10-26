/**
 * Approve a Jira admin change request — the only way one ever reaches Jira
 * (docs/project-management-design.md, "The confirm rule").
 *
 * A browser session, never an MCP token: this is the click the confirm
 * rule is about, and no MCP host can prove a click was a person's. Only an
 * operator may approve, on their own Jira Administration grant, and only
 * while the org would still let them apply it (applyGate). Whoever
 * proposed it, the operator is the one who holds the key: the operations
 * run on their connection, not the requester's.
 *
 * Approving does not apply inside this request. It queues the change and
 * answers 202 at once; the job (lib/jira-admin/apply-job.ts) runs it on the
 * server and reports progress on the row, so the operator can leave the
 * page and come back to see how it went. The operations come from the
 * stored row — the body is ignored — so what runs is exactly what the
 * review page showed.
 */

import { NextRequest, NextResponse, after } from 'next/server';
import { getDatabase } from '@renkei/db';
import { getSessionFromRequest } from '@/lib/session';
import { ROLE_OPERATOR } from '@/lib/access';
import {
  getChangeRequestById,
  queueChangeRequest,
  REQUEST_KIND,
  stateOf,
} from '@/lib/jira-admin/change-requests';
import { applyGate } from '@/lib/jira-admin/apply';
import { resolveApplyAccess, runApplyJob } from '@/lib/jira-admin/apply-job';
import { routeLog } from '@/lib/log-context';

const NOT_PENDING: Record<string, string> = {
  queued: 'This change request is already approved and waiting to be applied.',
  applying: 'This change request is already being applied.',
  applied: 'This change request has already been applied.',
  partial: 'This change request has already been applied, in part.',
  failed: 'This change request was already tried, and failed.',
  cancelled: 'This change request was cancelled.',
  expired: 'This change request has expired. Ask for the change again to get a fresh one.',
  interrupted: 'This change request was interrupted while applying; check Jira.',
};

async function POSTHandler(
  request: NextRequest,
  { params }: { params: Promise<{ changeId: string }> }
): Promise<NextResponse> {
  const { changeId } = await params;

  const session = await getSessionFromRequest(request);
  if (!session) {
    return NextResponse.json({ error: 'Not signed in' }, { status: 401 });
  }
  if (!session.roles.includes(ROLE_OPERATOR)) {
    return NextResponse.json(
      { error: 'Only an operator can approve a change to Jira.' },
      { status: 403 }
    );
  }

  const dbResult = getDatabase();
  if (!dbResult.ok) {
    return NextResponse.json({ error: 'Database error' }, { status: 500 });
  }
  const db = dbResult.val;

  const change = await getChangeRequestById(db, changeId);
  if (!change) {
    return NextResponse.json({ error: 'Change request not found' }, { status: 404 });
  }
  if (change.kind === REQUEST_KIND) {
    return NextResponse.json(
      {
        error:
          'This is a request in words, not a proposal. Ask in chat to build it as a proposal, or decline it.',
      },
      { status: 409 }
    );
  }
  const state = stateOf(change);
  if (state !== 'pending') {
    return NextResponse.json({ error: NOT_PENDING[state] ?? 'Not pending' }, { status: 409 });
  }

  const gate = await applyGate(db, session.subject, session.roles, change);
  if (!gate.ok) {
    return NextResponse.json({ error: gate.reason }, { status: 403 });
  }

  // Refuse now, with the reason, what the job would only fail later on: the
  // operator has no usable connection to the site this was proposed for.
  const resolved = await resolveApplyAccess(session.subject, change);
  if (typeof resolved === 'string') {
    return NextResponse.json({ error: resolved }, { status: 409 });
  }

  if (!(await queueChangeRequest(db, change.id, session.subject))) {
    return NextResponse.json(
      { error: 'This change request is no longer pending.' },
      { status: 409 }
    );
  }
  after(() => runApplyJob(db, change.id));

  return NextResponse.json({ status: 'queued' }, { status: 202 });
}

export const POST = routeLog(POSTHandler);
