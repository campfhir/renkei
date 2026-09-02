/**
 * Turn a report's revision brief into a revision DRAFT.
 *
 * The optimizer never edits an agent. What it produced is prose; the
 * drafting pipeline (the same one the builder's "describe it" box uses)
 * turns prose into steps against the owner's tool catalog, validates them,
 * and the builder offers the result on open for the owner to look at
 * before saving. This route is the seam between the two: it creates the
 * draft row exactly as the builder would have, scoped to this agent, and
 * records on the pass that it was applied.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getDatabase } from '@renkei/db';
import { agentJobsQueue } from '@renkei/queue';
import { triggerVariableDescriptors } from '@renkei/agents';
import { getSessionFromRequest } from '@/lib/session';
import { resolveAgentAccess } from '@/lib/agents/access-grants';
import { createDraft } from '@/lib/agents/draft-store';
import { getOptimization, markOptimizationApplied } from '@/lib/agents/optimization-store';
import { logger } from '@/lib/logger';

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
    return NextResponse.json({ error: 'Only the owner can revise this agent.' }, { status: 403 });
  }
  const agent = access.agent;

  const body: unknown = await request.json().catch(() => null);
  const payload: { optimizationId?: unknown } =
    typeof body === 'object' && body !== null ? body : {};
  const optimizationId = typeof payload.optimizationId === 'string' ? payload.optimizationId : '';
  const optimization = await getOptimization(db, tenantId, session.subject, optimizationId);
  if (!optimization || optimization.agentId !== agentId) {
    return NextResponse.json({ error: 'No such report' }, { status: 404 });
  }
  const brief = optimization.result?.revisionBrief;
  if (optimization.status !== 'succeeded' || !brief) {
    return NextResponse.json({ error: 'This report has no changes to draft.' }, { status: 409 });
  }
  // Already turned into a draft: hand back the same one rather than start
  // a second drafting job for the same brief.
  if (optimization.result?.draftId) {
    return NextResponse.json({ draftId: optimization.result.draftId, status: 'exists' });
  }

  const text = [
    `Revise this automation to fix the problems below. Keep every step the edits do not mention exactly as it is — same name, same instruction, same tool, same outcome lines.`,
    '',
    brief,
  ].join('\n');

  const draftId = await createDraft(db, {
    tenantId,
    ownerSubject: session.subject,
    agentId,
    request: {
      text,
      // The SAVED steps: the optimizer analyzed the saved agent, so its
      // edits are against that, not against an unsaved builder session.
      steps: JSON.parse(JSON.stringify(agent.steps)),
      triggerVars: triggerVariableDescriptors(agent.triggers.map((trigger) => trigger.draft)).map(
        ({ name, description }) => ({ name, description })
      ),
      // Triggers exist already; the draft never rewrites them.
      suggestTriggers: false,
      guardrails: agent.guardrails,
    },
  });

  const enqueued = await agentJobsQueue().producer.enqueue({
    tenantId,
    source: 'agents',
    type: 'draft',
    payload: { draftId },
    orderingKey: `draft:${tenantId}:${session.subject}`,
  });
  if (!enqueued.ok) {
    logger.error('could not enqueue optimizer draft {draftId}: {error}', {
      component: 'api/agents-optimize-apply',
      tenantId,
      draftId,
      error: enqueued.err.message ?? 'unknown',
    });
    await db.deleteFrom('agent_drafts').where('id', '=', draftId).execute();
    return NextResponse.json(
      { error: 'Could not start drafting. Try again in a moment.' },
      { status: 503 }
    );
  }

  await markOptimizationApplied(db, tenantId, session.subject, optimizationId, draftId);
  return NextResponse.json({ draftId, status: 'queued' }, { status: 202 });
}
