/**
 * Run this agent again on the SAME input, with its CURRENT steps.
 *
 * The point of the button is the second half: you read a failed run, saw
 * what the agent got wrong, fixed the steps — and now want the same
 * triggering message put back through the corrected agent. So this reads
 * the old run's initial_state (its trigger.* variables) and starts a fresh
 * run from the agent as it stands NOW. It deliberately does not resume the
 * old run: that run's snapshot is the version you just decided was wrong,
 * and half its attempt rows describe a plan that no longer exists.
 *
 * A new run, not a mutation of the old one, also keeps the history honest —
 * the failure stays on the record next to the retry.
 *
 * Owner or grantee, like the invoke route's session path: an unexpired
 * access grant (access-grants.ts) exists precisely for this loop — read
 * the failed run, fix the steps, put the same message back through. The
 * run still executes on the OWNER's grants; triggered_by_subject records
 * who pressed the button. Anyone else — an admin reading someone else's
 * run included — gets a 404 here, not a 403.
 *
 * This starts a fresh run of the same agent exactly like the invoke route
 * does, so it asks the same question first: a 409 `ALREADY_RUNNING` names
 * whichever OTHER run of this agent is still live, and the button re-sends
 * with `confirmQueue: true` once the person says to go ahead.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getDatabase } from '@renkei/db';
import { agentJobsQueue } from '@renkei/queue';
import { isCurrentStepsDoc } from '@renkei/agents';
import { createAgentRun, liveRunFor } from '@renkei/agents/runs';
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

  // Access is structural on both halves: the caller must resolve to the
  // agent (owner, or grantee through an unexpired grant), and the run must
  // be that agent's, in this tenant.
  const access = await resolveAgentAccess(db, tenantId, session.subject, agentId);
  if (!access) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const run = await db
    .selectFrom('agent_runs')
    .select(['id', 'status', 'initial_state', 'trigger_id', 'trigger_kind'])
    .where('tenant_id', '=', tenantId)
    .where('agent_id', '=', agentId)
    .where('id', '=', runId)
    .where('owner_subject', '=', access.ownerSubject)
    .executeTakeFirst();
  if (!run) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  // A run still in flight would be racing itself; let it finish or be
  // stopped first, so two runs never act on one message at once.
  if (run.status === 'queued' || run.status === 'running' || run.status === 'waiting') {
    return NextResponse.json({ error: 'This run has not finished yet.' }, { status: 409 });
  }

  const agent = await db
    .selectFrom('agents')
    .select(['id', 'owner_subject', 'steps', 'llm_model_id'])
    .where('tenant_id', '=', tenantId)
    .where('id', '=', agentId)
    .where('owner_subject', '=', access.ownerSubject)
    .executeTakeFirst();
  if (!agent) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  if (!isCurrentStepsDoc(agent.steps)) {
    return NextResponse.json(
      {
        error:
          'This agent is saved in an older format — open it in the builder and save to update it.',
      },
      { status: 409 }
    );
  }

  let confirmQueue = false;
  const raw = await request.text();
  if (raw.trim().length > 0) {
    try {
      const body: { confirmQueue?: unknown } = JSON.parse(raw);
      confirmQueue = body.confirmQueue === true;
    } catch {
      return NextResponse.json({ error: 'Body must be JSON' }, { status: 400 });
    }
  }

  // A different run of this agent may still be live — the ordering key
  // already serializes behind it, but pressing "Run again" is easy to do
  // without meaning to add a second run on top of one already going.
  if (!confirmQueue) {
    const liveRun = await liveRunFor(db, tenantId, agentId);
    if (liveRun) {
      return NextResponse.json(
        {
          error: 'A run of this agent is already in progress.',
          code: 'ALREADY_RUNNING',
          liveRun,
        },
        { status: 409 }
      );
    }
  }

  const initialState =
    typeof run.initial_state === 'object' &&
    run.initial_state !== null &&
    !Array.isArray(run.initial_state)
      ? { ...run.initial_state }
      : undefined;

  const created = await createAgentRun(db, agentJobsQueue().producer, {
    tenantId,
    agentId,
    ownerSubject: agent.owner_subject,
    steps: agent.steps,
    llmModelId: agent.llm_model_id,
    // Not the original trigger row: this run was started by a person
    // pressing a button, and the history should say so. The trigger's DATA
    // rides along in initialState, which is what the steps actually read.
    triggerId: null,
    triggerKind: 'manual',
    triggeredBySubject: session.subject,
    ...(initialState ? { initialState } : {}),
  });
  if (!created.ok) {
    const message =
      created.err.type === 'DAILY_RUN_CAP'
        ? 'This organization has reached its daily run limit.'
        : created.err.type === 'QUEUE_ERROR'
          ? 'The run could not be queued — try again shortly.'
          : 'The run could not be started.';
    return NextResponse.json({ error: message }, { status: 409 });
  }

  logger.info('run {runId} re-run as {newRunId} by {subject}', {
    component: 'web/agents',
    tenantId,
    runId,
    newRunId: created.val.runId,
    subject: session.subject,
  });
  return NextResponse.json({ runId: created.val.runId });
}
