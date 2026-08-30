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

import { sql, type Kysely } from 'kysely';
import type { DB } from '@renkei/db';
import type { QueueProducer } from '@renkei/queue';
import { logger } from './logger';

export const APPROVAL_SWEEP_MS = 60_000;

/** How long a decided card may sit before the sweep re-enqueues its run. */
const DECIDED_STUCK_MINUTES = 10;
/** Grace before a card-less waiting run is re-driven through the pause. */
const ORPHAN_GRACE_MINUTES = 60;

export function createApprovalSweep(db: Kysely<DB>, producer: QueueProducer) {
  const enqueueResume = async (run: {
    id: string;
    tenant_id: string;
    agent_id: string;
  }): Promise<void> => {
    const result = await producer.enqueue({
      tenantId: run.tenant_id,
      source: `agents:${run.agent_id}`,
      type: 'run',
      payload: { runId: run.id },
      orderingKey: `agent:${run.agent_id}`,
    });
    if (!result.ok) {
      logger.warn('approval sweep could not enqueue resume for run {runId}', {
        component: 'worker-agents/approval-sweep',
        runId: run.id,
        tenantId: run.tenant_id,
      });
    }
  };

  return async function sweepApprovals(): Promise<void> {
    // Arm 1: timeouts.
    const dueRuns = await db
      .selectFrom('agent_runs')
      .select(['id', 'tenant_id', 'agent_id'])
      .where('status', '=', 'waiting')
      .where('waiting_until', '<=', sql<Date>`NOW()`)
      .limit(100)
      .execute();
    for (const run of dueRuns) {
      const claimed = await db
        .updateTable('actionable_items')
        .set({
          status: 'expired',
          decided_at: sql`NOW()`,
          archived_at: sql`NOW()`,
          result: JSON.stringify({ reason: 'timeout' }),
          updated_at: sql`NOW()`,
        })
        .where('run_id', '=', run.id)
        .where('status', '=', 'suggested')
        .executeTakeFirst();
      logger.info('approval wait expired for run {runId} (claimed: {claimed})', {
        component: 'worker-agents/approval-sweep',
        runId: run.id,
        tenantId: run.tenant_id,
        claimed: Number(claimed.numUpdatedRows ?? 0) > 0,
      });
      // Enqueue REGARDLESS of the claim: a lost claim means a human decided
      // concurrently, and their route's enqueue may have crashed.
      await enqueueResume(run);
    }

    // Arm 2: decided cards whose run never woke.
    const stuck = await db
      .selectFrom('agent_runs as r')
      .innerJoin('actionable_items as c', 'c.run_id', 'r.id')
      .select(['r.id', 'r.tenant_id', 'r.agent_id'])
      .where('r.status', '=', 'waiting')
      .where('c.status', 'in', ['approved', 'declined', 'expired', 'answered'])
      .where(
        'c.decided_at',
        '<=',
        sql<Date>`NOW() - make_interval(mins => ${DECIDED_STUCK_MINUTES})`
      )
      .limit(100)
      .execute();
    for (const run of stuck) {
      logger.warn('waiting run {runId} has a decided card; re-enqueueing resume', {
        component: 'worker-agents/approval-sweep',
        runId: run.id,
        tenantId: run.tenant_id,
      });
      await enqueueResume(run);
    }

    // Arm 3a: waiting runs with no card at all.
    const orphans = await db
      .selectFrom('agent_runs as r')
      .leftJoin('actionable_items as c', 'c.run_id', 'r.id')
      .select(['r.id', 'r.tenant_id', 'r.agent_id'])
      .where('r.status', '=', 'waiting')
      .where('c.id', 'is', null)
      .where(
        'r.updated_at',
        '<=',
        sql<Date>`NOW() - make_interval(mins => ${ORPHAN_GRACE_MINUTES})`
      )
      .limit(100)
      .execute();
    for (const run of orphans) {
      logger.warn('waiting run {runId} has no approval card; re-driving the pause', {
        component: 'worker-agents/approval-sweep',
        runId: run.id,
        tenantId: run.tenant_id,
      });
      await enqueueResume(run);
    }

    // Arm 3b: still-open cards whose run already ended some other way.
    await db
      .updateTable('actionable_items')
      .set({
        status: 'expired',
        decided_at: sql`NOW()`,
        archived_at: sql`NOW()`,
        result: JSON.stringify({ reason: 'run-ended' }),
        updated_at: sql`NOW()`,
      })
      .where('status', '=', 'suggested')
      .where('run_id', 'is not', null)
      .where(({ exists, selectFrom, not }) =>
        not(
          exists(
            selectFrom('agent_runs')
              .select('agent_runs.id')
              .whereRef('agent_runs.id', '=', 'actionable_items.run_id')
              .where('agent_runs.status', 'in', ['waiting', 'running', 'queued'])
          )
        )
      )
      .execute();
  };
}
