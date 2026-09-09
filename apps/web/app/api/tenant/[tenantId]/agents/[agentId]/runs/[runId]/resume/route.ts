/**
 * Resume a FAILED run at the step it failed on — the same run, with that
 * step's attempts set aside and, when the caller adds one, a note on what
 * to do differently. The semantics live in resumeAgentRun
 * (@renkei/agents/runs); this route only checks who is asking and, like
 * the rerun route, asks before piling a resumed run on top of one already
 * in flight for the same agent.
 *
 * Owner or grantee, same as cancel and rerun: an unexpired access grant
 * exists for exactly this troubleshooting loop. The run keeps executing
 * on the OWNER's grants; resumed_by records who pressed the button.
 * Anyone else gets a 404, not a 403.
 *
 * Body: `{ guidance?: string, confirm?: boolean }`, both optional.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getDatabase } from '@renkei/db';
import { agentJobsQueue } from '@renkei/queue';
import { findInProgressRun, resumeAgentRun } from '@renkei/agents/runs';
import { getSessionFromRequest } from '@/lib/session';
import { resolveAgentAccess } from '@/lib/agents/access-grants';
import { isUuid } from '@/lib/uuid';
import { logger } from '@/lib/logger';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ tenantId: string; agentId: string; runId: string }> }
): Promise<NextResponse> {
  const { tenantId, agentId, runId } = await params;
  if (!isUuid(agentId) || !isUuid(runId)) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  const session = await getSessionFromRequest(request, tenantId);
  if (!session) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });

  const dbResult = getDatabase();
  if (!dbResult.ok) return NextResponse.json({ error: 'Database unavailable' }, { status: 500 });
  const db = dbResult.val;

  const access = await resolveAgentAccess(db, tenantId, session.subject, agentId);
  if (!access) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const raw = await request.text();
  let guidance = '';
  let confirmed = false;
  if (raw.trim().length > 0) {
    try {
      const body: { guidance?: unknown; confirm?: unknown } = JSON.parse(raw);
      guidance = typeof body.guidance === 'string' ? body.guidance : '';
      confirmed = body.confirm === true;
    } catch {
      return NextResponse.json({ error: 'Body must be JSON' }, { status: 400 });
    }
  }

  const run = await db
    .selectFrom('agent_runs')
    .select(['id', 'status', 'trigger_kind'])
    .where('tenant_id', '=', tenantId)
    .where('agent_id', '=', agentId)
    .where('id', '=', runId)
    .where('owner_subject', '=', access.ownerSubject)
    .executeTakeFirst();
  if (!run) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  // The rerun route's guard, for the same reason: an event agent already
  // runs several at once by design; a scheduled/manual one is the case
  // where a second run in flight deserves a beat before proceeding.
  if (run.trigger_kind !== 'event' && !confirmed) {
    const inProgress = await findInProgressRun(db, tenantId, agentId);
    if (inProgress) {
      return NextResponse.json(
        {
          error: `A run of this agent is already ${inProgress.status}.`,
          code: 'already-in-progress',
          runId: inProgress.id,
          status: inProgress.status,
        },
        { status: 409 }
      );
    }
  }

  const resumed = await resumeAgentRun(db, agentJobsQueue().producer, {
    tenantId,
    agentId,
    runId,
    ownerSubject: access.ownerSubject,
    resumedBySubject: session.subject,
    guidance,
  });
  if (!resumed.ok) {
    switch (resumed.err.type) {
      case 'NOT_FOUND':
        return NextResponse.json({ error: 'Not found' }, { status: 404 });
      case 'NOT_FAILED':
      case 'NOT_RESUMABLE':
        return NextResponse.json(
          { error: resumed.err.message ?? 'This run cannot be resumed.' },
          { status: 409 }
        );
      case 'QUEUE_ERROR':
        return NextResponse.json(
          { error: 'The run could not be queued — try again shortly.' },
          { status: 409 }
        );
      case 'DB_ERROR':
        return NextResponse.json({ error: 'The run could not be resumed.' }, { status: 500 });
    }
  }

  logger.info('run {runId} resumed at step "{stepName}" by {subject}', {
    component: 'web/agents',
    tenantId,
    runId,
    stepName: resumed.val.stepName ?? '(start)',
    retiredAttempts: resumed.val.retiredAttempts,
    subject: session.subject,
  });
  return NextResponse.json({
    runId,
    stepName: resumed.val.stepName,
    retiredAttempts: resumed.val.retiredAttempts,
  });
}
