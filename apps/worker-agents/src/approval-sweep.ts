/**
 * The approval sweep — what keeps waiting runs honest when nobody clicks.
 * Generic over card KIND: a `needsApproval` gate's 'approval' card and an
 * `ask_person` pause's 'question' card share the same run_id/waiting_until
 * plumbing, so one sweep drives both — nothing here reads `kind` at all.
 *
 * Three healing arms, every one replica-safe (the card's optimistic
 * status claim is the arbiter, and duplicate {runId} enqueues are
 * harmless — the engine replays):
 *
 *  1. TIMEOUTS: a waiting run past `waiting_until` gets its card claimed
 *     `suggested → expired` (archived, reason recorded) and the run
 *     re-enqueued — the engine treats the timeout as denied/unanswered. A
 *     LOST claim means a human decided in the same instant; the run is
 *     re-enqueued anyway, because their decision route may have crashed
 *     before its own enqueue.
 *  2. DECIDED-BUT-STUCK: a run still waiting minutes after its card was
 *     decided (approved/declined/expired, or a question answered) means
 *     the decision route claimed the card but died before enqueueing the
 *     resume. Re-enqueue; the engine reads the card.
 *  3. ORPHANS: a waiting run with no linked card at all (a crash between
 *     the attempt row and the card insert) is re-enqueued after a grace
 *     hour — the engine re-runs the pause and recreates the card. And the
 *     mirror orphan: a still-suggested card whose run is already terminal
 *     (canceled elsewhere) is expired+archived so the feed never shows a
 *     dead decision.
 */

import { getDataStore } from '@renkei/db';
import type { QueueProducer } from '@renkei/queue';
import { logger } from './logger';

export const APPROVAL_SWEEP_MS = 60_000;

/** How long a decided card may sit before the sweep re-enqueues its run. */
const DECIDED_STUCK_MINUTES = 10;
/** Grace before a card-less waiting run is re-driven through the pause. */
const ORPHAN_GRACE_MINUTES = 60;

/** How many runs each arm takes per pass. */
const ARM_BATCH = 100;

export function createApprovalSweep(producer: QueueProducer) {
  const enqueueResume = async (run: { id: string; agentId: string }): Promise<void> => {
    const result = await producer.enqueue({
      source: `agents:${run.agentId}`,
      type: 'run',
      payload: { runId: run.id },
      orderingKey: `agent:${run.agentId}`,
    });
    if (!result.ok) {
      logger.warn('approval sweep could not enqueue resume for run {runId}', {
        component: 'worker-agents/approval-sweep',
        runId: run.id,
      });
    }
  };

  return async function sweepApprovals(): Promise<void> {
    const runs = getDataStore().agentRuns;
    const now = Date.now();

    // Arm 1: timeouts.
    const dueRuns = await runs.listDueWaiting(new Date(now), ARM_BATCH);
    for (const run of dueRuns) {
      const claimed = await runs.expireWaitingCard(run.id, 'timeout');
      logger.info('approval wait expired for run {runId} (claimed: {claimed})', {
        component: 'worker-agents/approval-sweep',
        runId: run.id,
        claimed,
      });
      // Enqueue REGARDLESS of the claim: a lost claim means a human decided
      // concurrently, and their route's enqueue may have crashed.
      await enqueueResume(run);
    }

    // Arm 2: decided cards whose run never woke.
    const stuck = await runs.listWaitingWithDecidedCard(
      new Date(now - DECIDED_STUCK_MINUTES * 60_000),
      ARM_BATCH
    );
    for (const run of stuck) {
      logger.warn('waiting run {runId} has a decided card; re-enqueueing resume', {
        component: 'worker-agents/approval-sweep',
        runId: run.id,
      });
      await enqueueResume(run);
    }

    // Arm 3a: waiting runs with no card at all.
    const orphans = await runs.listWaitingWithoutCard(
      new Date(now - ORPHAN_GRACE_MINUTES * 60_000),
      ARM_BATCH
    );
    for (const run of orphans) {
      logger.warn('waiting run {runId} has no approval card; re-driving the pause', {
        component: 'worker-agents/approval-sweep',
        runId: run.id,
      });
      await enqueueResume(run);
    }

    // Arm 3b: still-open cards whose run already ended some other way.
    await runs.expireCardsOfEndedRuns();
  };
}
