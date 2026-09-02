/**
 * Optimization hygiene — the draft sweep's twin (draft-sweep.ts).
 *
 * A pass is claimed by flipping `queued` → `running`; a process that dies
 * mid-analysis leaves a row nothing can claim again, so a `running` row
 * past a generous deadline is FAILED with a message that says so. And
 * reports accumulate: they quote step names and error messages, so they
 * are pruned rather than kept forever — the newest one is all the agent
 * page ever shows.
 */

import { sql, type Kysely } from 'kysely';
import type { DB } from '@renkei/db';
import { logger } from './logger';

export const OPTIMIZATION_SWEEP_INTERVAL_MS = 5 * 60_000;

/** Past the worst honest case: one long model call under a 20-minute token. */
const STUCK_MINUTES = 25;

const RETENTION_DAYS = 60;
const RETENTION_BATCH = 500;

export function createOptimizationSweep(db: Kysely<DB>) {
  return async function sweep(): Promise<void> {
    const rescued = await sql<{ id: string }>`
      UPDATE agent_optimizations
         SET status = 'failed',
             error = 'The analysis stopped unexpectedly and did not finish. Try again.',
             finished_at = NOW(),
             updated_at = NOW()
       WHERE status = 'running'
         AND updated_at < NOW() - make_interval(mins => ${STUCK_MINUTES})
      RETURNING id
    `.execute(db);
    if (rescued.rows.length > 0) {
      logger.warn('failed {count} optimization(s) stuck mid-flight', {
        component: 'worker-agents/optimization-sweep',
        count: rescued.rows.length,
      });
    }

    const pruned = await sql<{ id: string }>`
      DELETE FROM agent_optimizations WHERE id IN (
        SELECT id FROM agent_optimizations
         WHERE created_at < NOW() - make_interval(days => ${RETENTION_DAYS})
         ORDER BY created_at
         LIMIT ${RETENTION_BATCH}
      ) RETURNING id
    `.execute(db);
    if (pruned.rows.length > 0) {
      logger.info('retention pruned {count} optimization(s)', {
        component: 'worker-agents/optimization-sweep',
        count: pruned.rows.length,
      });
    }
  };
}
