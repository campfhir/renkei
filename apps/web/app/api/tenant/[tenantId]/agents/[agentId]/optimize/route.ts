/**
 * Start an optimization pass over one agent, and read the latest one.
 *
 * Owner only — a grantee sees the agent but not its run content, and the
 * pass reads run content. Starting is a job (a row plus a queue message,
 * the draft route's shape); the agents worker calls back into
 * `optimize/[optimizationId]/run` to do the work, and the page polls GET.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getDatabase } from '@renkei/db';
import { agentJobsQueue } from '@renkei/queue';
import { getSessionFromRequest } from '@/lib/session';
import { resolveAgentAccess } from '@/lib/agents/access-grants';
import {
  createOptimization,
  inFlightOptimization,
  latestOptimization,
} from '@/lib/agents/optimization-store';
import { logger } from '@/lib/logger';

/** How far back a pass looks. Matches the captured-failure attention window. */
const WINDOW_DAYS = 30;

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ tenantId: string; agentId: string }> }
): Promise<NextResponse> {
  const { tenantId, agentId } = await params;
  const session = await getSessionFromRequest(request, tenantId);
  if (!session) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });

  const dbResult = getDatabase();
  if (!dbResult.ok) return NextResponse.json({ error: 'Database unavailable' }, { status: 500 });
  const db = dbResult.val;

  const access = await resolveAgentAccess(db, tenantId, session.subject, agentId);
  if (!access) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  if (!access.viewerIsOwner) {
    return NextResponse.json({ error: 'Only the owner can analyze this agent.' }, { status: 403 });
  }

  // One at a time: a second pass while the first runs would spend a second
  // model call on the same evidence for the same answer.
  const running = await inFlightOptimization(db, tenantId, agentId);
  if (running) {
    return NextResponse.json({ optimizationId: running.id, status: 'queued' }, { status: 202 });
  }

  const optimizationId = await createOptimization(db, {
    tenantId,
    ownerSubject: session.subject,
    agentId,
    request: { windowDays: WINDOW_DAYS },
  });

  const enqueued = await agentJobsQueue().producer.enqueue({
    tenantId,
    source: 'agents',
    type: 'optimize',
    payload: { optimizationId },
    orderingKey: `optimize:${tenantId}:${session.subject}`,
  });
  if (!enqueued.ok) {
    logger.error('could not enqueue optimization {optimizationId}: {error}', {
      component: 'api/agents-optimize',
      tenantId,
      optimizationId,
      error: enqueued.err.message ?? 'unknown',
    });
    await db.deleteFrom('agent_optimizations').where('id', '=', optimizationId).execute();
    return NextResponse.json(
      { error: 'Could not start the analysis. Try again in a moment.' },
      { status: 503 }
    );
  }

  return NextResponse.json({ optimizationId, status: 'queued' }, { status: 202 });
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ tenantId: string; agentId: string }> }
): Promise<NextResponse> {
  const { tenantId, agentId } = await params;
  const session = await getSessionFromRequest(request, tenantId);
  if (!session) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });

  const dbResult = getDatabase();
  if (!dbResult.ok) return NextResponse.json({ error: 'Database unavailable' }, { status: 500 });

  // Owner-scoped by the read itself: a grantee (or anyone else) gets null,
  // which is the same answer as "no pass yet".
  const optimization = await latestOptimization(dbResult.val, tenantId, session.subject, agentId);
  return NextResponse.json({ optimization });
}
