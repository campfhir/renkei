/**
 * Draft hygiene: rescue the stuck, then forget the old.
 *
 * Two problems, one sweep.
 *
 * A draft is claimed by flipping `queued` → `running`, which is what makes a
 * redelivered queue row a no-op. The cost of that guarantee is that a
 * process which dies mid-draft leaves a row nothing can ever claim again:
 * the queue retries, the claim fails, and the builder polls a draft that
 * will never move. So a `running` row past a generous deadline is FAILED
 * with a message that says what happened, because a draft that visibly gave
 * up is worth far more than one that spins forever.
 *
 * And drafts accumulate. They hold prose someone wrote and the steps they
 * were editing — content, not telemetry — so they are pruned rather than
 * kept indefinitely. Consumed ones especially: their result is already in
 * an agent.
 */

import { sql, type Kysely } from 'kysely';
import type { DB } from '@renkei/db';
import { logger } from './logger';

export const DRAFT_SWEEP_INTERVAL_MS = 5 * 60_000;

/**
 * How long a draft may sit in `running` before it is declared dead.
 *
 * Generously past the worst honest case: the run route's own drafting can
 * take a few minutes of model time, and the worker's token is good for
 * twenty. Anything past this is not slow, it is gone.
 */
const STUCK_MINUTES = 25;

/** Drafts are content; they do not outlive their usefulness by much. */
const RETENTION_DAYS = 14;
const RETENTION_BATCH = 500;

export function createDraftSweep(db: Kysely<DB>) {
  return async function sweep(): Promise<void> {
    const rescued = await sql<{ id: string }>`
      UPDATE agent_drafts
         SET status = 'failed',
             error = 'Drafting stopped unexpectedly and did not finish. Try again.',
             finished_at = NOW(),
             updated_at = NOW()
       WHERE status = 'running'
         AND updated_at < NOW() - make_interval(mins => ${STUCK_MINUTES})
      RETURNING id
    `.execute(db);
    if (rescued.rows.length > 0) {
      // At warn: a draft dying mid-flight means a process died mid-flight,
      // which is worth someone's attention even though the user is told.
      logger.warn('failed {count} draft(s) stuck mid-flight', {
        component: 'worker-agents/draft-sweep',
        count: rescued.rows.length,
      });
    }

    const pruned = await sql<{ id: string }>`
      DELETE FROM agent_drafts WHERE id IN (
        SELECT id FROM agent_drafts
         WHERE created_at < NOW() - make_interval(days => ${RETENTION_DAYS})
         ORDER BY created_at
         LIMIT ${RETENTION_BATCH}
      ) RETURNING id
    `.execute(db);
    if (pruned.rows.length > 0) {
      logger.info('retention pruned {count} draft(s)', {
        component: 'worker-agents/draft-sweep',
        count: pruned.rows.length,
      });
    }
  };
}
