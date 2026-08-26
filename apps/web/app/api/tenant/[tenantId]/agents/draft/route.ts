/**
 * Prose → drafted steps, started as a JOB.
 *
 * This used to do the whole thing synchronously: the builder POSTed a
 * description and held a spinner open for up to 150 seconds of model time.
 * Navigating away threw the work away, a reload lost a result that had
 * already arrived, and the request was a long-lived connection through
 * whatever proxies sit in front of the app — the kind of thing that times
 * out at sixty seconds somewhere you cannot see.
 *
 * So this validates, writes an `agent_drafts` row, enqueues a job and
 * returns immediately. The builder polls the draft; the work happens in the
 * agents worker, which calls back into `draft/[draftId]/run` to do it. The
 * answer is durable either way, so leaving the page costs nothing.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getDatabase } from '@renkei/db';
import { agentJobsQueue } from '@renkei/queue';
import { isAgentStepsDoc } from '@renkei/agents';
import { getSessionFromRequest } from '@/lib/session';
import { createDraft, latestReadyDraft } from '@/lib/agents/draft-store';
import { isUuid } from '@/lib/uuid';
import { logger } from '@/lib/logger';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ tenantId: string }> }
): Promise<NextResponse> {
  const { tenantId } = await params;
  const session = await getSessionFromRequest(request, tenantId);
  if (!session) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });

  const dbResult = getDatabase();
  if (!dbResult.ok) return NextResponse.json({ error: 'Database unavailable' }, { status: 500 });

  const body: unknown = await request.json().catch(() => null);
  const payload: {
    text?: unknown;
    steps?: unknown;
    triggerVars?: unknown;
    suggestTriggers?: unknown;
    guardrails?: unknown;
    agentId?: unknown;
  } = typeof body === 'object' && body !== null ? body : {};
  if (typeof payload.text !== 'string' || payload.text.trim().length < 10) {
    return NextResponse.json(
      { error: 'Describe the automation in a sentence or two first.' },
      { status: 400 }
    );
  }

  // Revision context: the builder's CURRENT (possibly unsaved) steps — the
  // model revises what the user is looking at, not what was last saved. Kept
  // on the row rather than re-read at run time for exactly that reason.
  const steps = isAgentStepsDoc(payload.steps) ? payload.steps : null;
  // An agent id is accepted only when it is one of THIS caller's agents: it
  // becomes the draft's scope, and the builder later offers the draft on
  // opening that agent.
  const agentId =
    typeof payload.agentId === 'string' && isUuid(payload.agentId)
      ? ((
          await dbResult.val
            .selectFrom('agents')
            .select('id')
            .where('tenant_id', '=', tenantId)
            .where('owner_subject', '=', session.subject)
            .where('id', '=', payload.agentId)
            .executeTakeFirst()
        )?.id ?? null)
      : null;

  const draftId = await createDraft(dbResult.val, {
    tenantId,
    ownerSubject: session.subject,
    agentId,
    request: {
      text: payload.text.trim(),
      steps: steps ? JSON.parse(JSON.stringify(steps)) : null,
      triggerVars: Array.isArray(payload.triggerVars)
        ? JSON.parse(JSON.stringify(payload.triggerVars))
        : [],
      suggestTriggers: payload.suggestTriggers === true,
      guardrails: typeof payload.guardrails === 'string' ? payload.guardrails : null,
    },
  });

  // Enqueued AFTER the row exists, so a job can never arrive before the
  // draft it names. The reverse order would produce a job that looks like a
  // bug and is actually a race.
  const enqueued = await agentJobsQueue().producer.enqueue({
    tenantId,
    source: 'agents',
    type: 'draft',
    payload: { draftId },
    // Drafts for one person stay serial: two at once would race for the
    // same builder and cost double the model time for one usable answer.
    orderingKey: `draft:${tenantId}:${session.subject}`,
  });
  if (!enqueued.ok) {
    logger.error('could not enqueue draft job {draftId}: {error}', {
      component: 'api/agents-draft',
      tenantId,
      draftId,
      error: enqueued.err.message ?? 'unknown',
    });
    return NextResponse.json(
      { error: 'Could not start drafting. Try again in a moment.' },
      { status: 503 }
    );
  }

  return NextResponse.json({ draftId, status: 'queued' }, { status: 202 });
}

/**
 * The draft waiting to be picked up, if any.
 *
 * What the builder asks on open, so a draft that finished after someone
 * navigated away is offered rather than lost. `agentId` scopes it: a
 * revision belongs to the agent it revises, and a draft with no agent is
 * for the next new one.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ tenantId: string }> }
): Promise<NextResponse> {
  const { tenantId } = await params;
  const session = await getSessionFromRequest(request, tenantId);
  if (!session) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });

  const dbResult = getDatabase();
  if (!dbResult.ok) return NextResponse.json({ error: 'Database unavailable' }, { status: 500 });

  const requested = request.nextUrl.searchParams.get('agentId');
  const agentId = requested && isUuid(requested) ? requested : null;
  const draft = await latestReadyDraft(dbResult.val, tenantId, session.subject, agentId);
  return NextResponse.json({ draft });
}
