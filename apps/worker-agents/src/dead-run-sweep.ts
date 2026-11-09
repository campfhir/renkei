/**
 * The dead-run sweep: halts runs that will never finish on their own, so a
 * backlog that has stopped moving clears itself instead of piling up for
 * weeks behind a queue nobody is draining.
 *
 * Dead means:
 *  - queued or running with no progress for DEAD_AFTER_MS (the clock starts
 *    at the latest resume, else creation) — far past the stuck horizon
 *    (two hours, lib/agents/stuck.ts) a person can halt at by hand;
 *  - waiting more than WAIT_GRACE_MS past its own deadline: the approval
 *    sweep re-enqueues a run the moment its wait runs out, so one still
 *    waiting an hour later was never woken;
 *  - waiting with no deadline at all for DEAD_AFTER_MS — except a run
 *    parked for its owner's sign-in (`needs-sign-in`), which waits as long
 *    as it takes by design: the owner's next sign-in runs it.
 *
 * A halt is the operator's force-halt (apps/web lib/agents/force-halt.ts),
 * done here so it runs whether or not anyone opens a page: the run straight
 * to canceled with error kind `force_halted` (it reads Halted everywhere),
 * its running attempt closed, its queue jobs and dead letters dropped, and
 * the run log told. Unlike the stuck-run janitor it does not wait for the
 * run's job row to disappear — a job that is still "live" after a day is
 * exactly what holds the queue.
 *
 * It runs on its own timer, apart from the queue consumer, so it still runs
 * when that consumer has stopped taking jobs. Replica-safe: forceCancel is a
 * guarded claim, so two sweeps (or a sweep and an operator) halt a run once.
 */

import { getDataStore } from '@renkei/db';
import { recordAgentRunOutcome } from '@renkei/agents/runs';
import { logger } from './logger';

export const DEAD_RUN_SWEEP_MS = 10 * 60_000;
/** No progress this long, a queued or running run is dead. */
export const DEAD_AFTER_MS = 24 * 60 * 60_000;
/** A wait this long past its deadline was never woken. */
export const WAIT_GRACE_MS = 60 * 60_000;
/** Runs halted per pass; a bigger backlog clears over the next passes. */
const BATCH = 200;

/** Who the run's record says halted it. */
export const DEAD_RUN_HALTER = 'system:dead-run-sweep';
const HALTED_ERROR =
  'Halted automatically — the run had not moved in over a day, or its wait ran out and it was never woken.';

export function createDeadRunSweep(now: () => number = Date.now) {
  return async function sweepDeadRuns(): Promise<void> {
    const store = getDataStore();
    const at = now();
    const dead = await store.agentRuns.listDead(
      { clockBefore: new Date(at - DEAD_AFTER_MS), waitDueBefore: new Date(at - WAIT_GRACE_MS) },
      BATCH
    );
    let halted = 0;
    for (const run of dead) {
      const claimed = await store.agentRuns.forceCancel(run.id, {
        bySubject: DEAD_RUN_HALTER,
        errorKind: 'force_halted',
        error: HALTED_ERROR,
      });
      if (!claimed) continue; // finished, or halted elsewhere, in the meantime
      await store.queues.discardAgentRunJobs(run.id);
      await recordAgentRunOutcome({
        agentId: run.agentId,
        runId: run.id,
        ownerSubject: run.ownerSubject,
        status: 'canceled',
        errorKind: 'force_halted',
        error: HALTED_ERROR,
      });
      halted += 1;
      logger.warn('run {runId} halted automatically: it was {status} and not moving', {
        component: 'worker-agents/dead-run-sweep',
        runId: run.id,
        agentId: run.agentId,
        subject: run.ownerSubject,
        status: run.status,
      });
    }
    if (halted > 0) {
      logger.warn('dead-run sweep halted {halted} runs', {
        component: 'worker-agents/dead-run-sweep',
        halted,
      });
    }
  };
}
