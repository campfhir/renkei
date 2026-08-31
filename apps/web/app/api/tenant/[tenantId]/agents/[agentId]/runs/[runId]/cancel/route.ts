/**
 * Stop a run that has not finished yet.
 *
 * Owner or grantee, like the rerun route's session path: an unexpired
 * access grant exists precisely for this — troubleshooting someone else's
 * stuck agent includes being able to stop it. The run still executes on
 * the OWNER's grants; cancel_requested_by records who pressed the button.
 *
 * This route never touches agent_runs.status itself — see
 * requestRunCancellation and, on the other side, engine.ts's per-step
 * checkpoint. It only asks; the engine is what makes it real.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getDatabase } from '@renkei/db';
import { agentJobsQueue } from '@renkei/queue';
import { getSessionFromRequest } from '@/lib/session';
import { resolveAgentAccess } from '@/lib/agents/access-grants';
import { requestRunCancellation } from '@/lib/agents/run-cancellation';
import { isUuid } from '@/lib/uuid';

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

  const result = await requestRunCancellation(db, agentJobsQueue().producer, {
    tenantId,
    agentId,
    runId,
    ownerSubject: access.ownerSubject,
    canceledBySubject: session.subject,
  });

  switch (result.outcome) {
    case 'not-found':
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    case 'already-final':
      return NextResponse.json(
        { error: `This run already ${result.status === 'canceled' ? 'was canceled' : result.status}.` },
        { status: 409 }
      );
    case 'canceling':
      return NextResponse.json({ ok: true });
  }
}
