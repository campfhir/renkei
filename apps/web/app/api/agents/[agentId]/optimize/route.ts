/**
 * Start an optimization pass over one agent, and read the latest one.
 *
 * Owner only — a grantee sees the agent but not its run content, and the
 * pass reads run content. Starting is a job (a row plus a queue message,
 * the draft route's shape); the agents worker calls back into
 * `optimize/[optimizationId]/run` to do the work, and the page polls GET.
 */

import { NextRequest, NextResponse } from 'next/server';
import { agentJobsQueue } from '@renkei/queue';
import { getOrgSettings } from '@renkei/settings';
import { getSessionFromRequest } from '@/lib/session';
import { resolveAgentAccess } from '@/lib/agents/access-grants';
import {
  createOptimization,
  deleteOptimization,
  inFlightOptimization,
  latestOptimization,
} from '@/lib/agents/optimization-store';
import { logger } from '@/lib/logger';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ agentId: string }> }
): Promise<NextResponse> {
  const { agentId } = await params;
  const session = await getSessionFromRequest(request);
  if (!session) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });

  const access = await resolveAgentAccess(session.subject, agentId);
  if (!access) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  if (!access.viewerIsOwner) {
    return NextResponse.json({ error: 'Only the owner can analyze this agent.' }, { status: 403 });
  }

  // One at a time: a second pass while the first runs would spend a second
  // model call on the same evidence for the same answer.
  const running = await inFlightOptimization(agentId);
  if (running) {
    return NextResponse.json({ optimizationId: running.id, status: 'queued' }, { status: 202 });
  }

  // The org's window, frozen onto the row: the report says what it looked
  // at even if the setting changes afterwards.
  const settings = await getOrgSettings();
  if (!settings.ok) {
    logger.error('Settings unavailable: {error}', {
      component: 'api/agents-optimize',
      subject: session.subject,
      agentId,
      error: settings.err.message ?? settings.err.type,
    });
    return NextResponse.json({ error: 'Settings unavailable' }, { status: 500 });
  }
  const optimizationId = await createOptimization({
    ownerSubject: session.subject,
    agentId,
    request: { windowDays: settings.val.agentOptimizerWindowDays },
  });

  const enqueued = await agentJobsQueue().producer.enqueue({
    source: 'agents',
    type: 'optimize',
    payload: { optimizationId },
    orderingKey: `optimize:${session.subject}`,
  });
  if (!enqueued.ok) {
    logger.error('could not enqueue optimization {optimizationId}: {error}', {
      component: 'api/agents-optimize',
      optimizationId,
      error: enqueued.err.message ?? 'unknown',
    });
    await deleteOptimization(optimizationId);
    return NextResponse.json(
      { error: 'Could not start the analysis. Try again in a moment.' },
      { status: 503 }
    );
  }

  return NextResponse.json({ optimizationId, status: 'queued' }, { status: 202 });
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ agentId: string }> }
): Promise<NextResponse> {
  const { agentId } = await params;
  const session = await getSessionFromRequest(request);
  if (!session) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });

  // Owner-scoped by the read itself: a grantee (or anyone else) gets null,
  // which is the same answer as "no pass yet".
  const optimization = await latestOptimization(session.subject, agentId);
  return NextResponse.json({ optimization });
}
