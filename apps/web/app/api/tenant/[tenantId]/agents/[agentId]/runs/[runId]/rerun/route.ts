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
 * Owner only, like the invoke route's session path: a run executes with the
 * owner's grants, so "who may press this" and "whose credentials does it
 * spend" have to be the same person. An admin reading someone else's run
 * gets a 404 here, not a 403.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getDatabase } from '@renkei/db';
import { agentJobsQueue } from '@renkei/queue';
import { isAgentStepsDoc } from '@renkei/agents';
import { createAgentRun } from '@renkei/agents/runs';
import { getSessionFromRequest } from '@/lib/session';
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

  // Ownership is structural on both halves: the run must be this caller's,
  // on this agent, in this tenant.
  const run = await db
    .selectFrom('agent_runs')
    .select(['id', 'status', 'initial_state', 'trigger_id', 'trigger_kind'])
    .where('tenant_id', '=', tenantId)
    .where('agent_id', '=', agentId)
    .where('id', '=', runId)
    .where('owner_subject', '=', session.subject)
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
    .where('owner_subject', '=', session.subject)
    .executeTakeFirst();
  if (!agent) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  if (!isAgentStepsDoc(agent.steps)) {
    return NextResponse.json(
      { error: 'The agent cannot run in its current state — fix the steps and save first.' },
      { status: 409 }
    );
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
