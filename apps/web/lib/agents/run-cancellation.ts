/**
 * The human half of stopping a run: requesting it.
 *
 * A QUEUED run has not started, so there is nothing for the engine to wind
 * down: it is canceled here and now (agentRuns.cancelQueued, which only
 * applies while the run is still queued) and its queued jobs discarded, so
 * a cancel lands in the request instead of waiting behind every job ahead
 * of it in the agent's queue. A worker that claimed the run's job a moment
 * before still stops at its first checkpoint, before any model call: the
 * cancel request is recorded too.
 *
 * Any other live run belongs to the ENGINE (approvals.ts's header, the same
 * rule): this writes `cancel_requested_at`, a one-way flag, and for a
 * waiting run wakes an executor the same way an approval decision does. A
 * `running` run needs no wake: it is already inside its one continuous
 * executeRun call, and that call notices the flag itself between steps —
 * see engine.ts's per-step checkpoint.
 *
 * The route and the MCP tool are both callers, so the semantics live here
 * once, same reasoning as decideApproval/answerQuestion.
 */

import { getDataStore } from '@renkei/db';
import { isUuid } from '@/lib/uuid';
import type { QueueProducer } from '@renkei/queue';
import { recordAgentRunOutcome } from '@renkei/agents/runs';
import { logger } from '@/lib/logger';
import { discardRunJobs } from './run-jobs';

export type RequestCancelRunResult =
  /** It was queued, and is canceled now. */
  | { outcome: 'canceled' }
  /** It had started: the engine stops it at its next checkpoint. */
  | { outcome: 'canceling' }
  | { outcome: 'already-final'; status: string }
  | { outcome: 'not-found' };

export async function requestRunCancellation(
  producer: QueueProducer,
  input: {
    agentId: string;
    runId: string;
    /** The run's owner_subject — whose grants it acts under. */
    ownerSubject: string;
    /** Who clicked cancel — the owner, or a grantee troubleshooting for them. */
    canceledBySubject: string;
  }
): Promise<RequestCancelRunResult> {
  if (!isUuid(input.runId) || !isUuid(input.agentId)) return { outcome: 'not-found' };
  const runs = getDataStore().agentRuns;
  const run = await runs.findStatus({
    agentId: input.agentId,
    runId: input.runId,
    ownerSubject: input.ownerSubject,
  });
  if (!run) return { outcome: 'not-found' };
  if (
    run.status === 'succeeded' ||
    run.status === 'failed' ||
    run.status === 'stopped' ||
    run.status === 'canceled'
  ) {
    return { outcome: 'already-final', status: run.status };
  }

  // Not started yet: cancel it outright. False means a worker started it
  // (or it finished) in the gap above — fall through to asking the engine.
  if (run.status === 'queued' && (await runs.cancelQueued(input.runId, input.canceledBySubject))) {
    await discardRunJobs(input.runId);
    await recordAgentRunOutcome({
      agentId: input.agentId,
      runId: input.runId,
      ownerSubject: input.ownerSubject,
      status: 'canceled',
    });
    logger.info('run {runId} canceled before it started', {
      component: 'agents/cancel',
      runId: input.runId,
      agentId: input.agentId,
      subject: input.ownerSubject,
      canceledBy: input.canceledBySubject,
    });
    return { outcome: 'canceled' };
  }

  // The one-way claim: first request wins, a repeat click or a second
  // caller racing it is a no-op rather than a second wake.
  const claimed = await runs.requestCancel(input.runId, input.canceledBySubject);
  if (!claimed) {
    // Already requested, or it reached a terminal status in the gap above
    // — either way there is nothing more for this call to do.
    return { outcome: 'canceling' };
  }

  logger.info('cancel requested for run {runId} ({status}); the engine stops it next', {
    component: 'agents/cancel',
    runId: input.runId,
    agentId: input.agentId,
    status: run.status,
    subject: input.ownerSubject,
    canceledBy: input.canceledBySubject,
  });

  // Queued and waiting runs have no worker actively driving them right
  // now — wake one, exactly the way an approval decision does, so the
  // flag gets noticed promptly instead of at the next unrelated poll.
  if (run.status === 'queued' || run.status === 'waiting') {
    await producer.enqueue({
      source: `agents:${input.agentId}`,
      type: 'run',
      payload: { runId: input.runId },
      orderingKey: `agent:${input.agentId}`,
    });
  }

  return { outcome: 'canceling' };
}
