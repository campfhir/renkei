/**
 * Stop a run that hasn't finished — the session-authenticated half of
 * `requestRunCancel` (@renkei/agents/runs), which an MCP tool (agent_run_cancel)
 * also calls, so the two never answer differently.
 *
 * Owner or grantee, same as every other run-acting route: an unexpired
 * access grant exists precisely so a helper can do this too. Anyone else —
 * an admin reading someone else's run included — gets a 404, not a 403.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getDatabase } from '@renkei/db';
import { agentJobsQueue } from '@renkei/queue';
import { requestRunCancel } from '@renkei/agents/runs';
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

  const run = await db
    .selectFrom('agent_runs')
    .select(['id'])
    .where('tenant_id', '=', tenantId)
    .where('agent_id', '=', agentId)
    .where('id', '=', runId)
    .where('owner_subject', '=', access.ownerSubject)
    .executeTakeFirst();
  if (!run) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const result = await requestRunCancel(db, agentJobsQueue().purger, tenantId, agentId, runId);
  switch (result.outcome) {
    case 'not-found':
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    case 'already-final':
      return NextResponse.json(
        { error: `This run already finished (${result.status}).` },
        { status: 409 }
      );
    case 'canceled':
    case 'cancel-requested':
      logger.info('run {runId} {outcome} by {subject}', {
        component: 'web/agents',
        tenantId,
        runId,
        outcome: result.outcome,
        subject: session.subject,
      });
      return NextResponse.json({ outcome: result.outcome });
  }
}
