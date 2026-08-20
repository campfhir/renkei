/**
 * Mail bulk job hygiene, one hourly sweep with two duties:
 *
 * 1. Fail 'running' jobs whose updated_at is stale — a job updates its row
 *    on every settled chunk, so an hour of silence means the worker died
 *    mid-run (and the queue's redelivery already finalized or will). The
 *    status tool must never show "running" forever.
 * 2. Prune terminal jobs older than the retention window, in bounded
 *    batches (the agent-runs retention shape).
 */

import { sql, type Kysely } from 'kysely';
import type { DB } from '@renkei/db';
import { logger } from '../logger';

export const MAIL_JOBS_SWEEP_INTERVAL_MS = 60 * 60_000;

/** Silence longer than this on a running job = the worker died mid-run. */
const STALL_MINUTES = 60;
/** Terminal rows older than this are pruned. */
const RETENTION_DAYS = 30;
const RETENTION_BATCH = 500;

export function createMailJobsSweep(db: Kysely<DB>) {
  return async function sweep(): Promise<void> {
    const stalled = await db
      .updateTable('mail_bulk_jobs')
      .set({
        status: 'failed',
        last_error: 'job stalled; the worker likely restarted mid-run',
        finished_at: sql`NOW()`,
        updated_at: sql`NOW()`,
      })
      .where('status', '=', 'running')
      .where('updated_at', '<', sql<Date>`NOW() - make_interval(mins => ${STALL_MINUTES})`)
      .executeTakeFirst();
    const stalledCount = Number(stalled.numUpdatedRows ?? 0);
    if (stalledCount > 0) {
      logger.warn('failed {count} stalled mail bulk job(s)', {
        component: 'mailjobs/sweep',
        count: stalledCount,
      });
    }

    const deleted = await sql<{ id: string }>`
      DELETE FROM mail_bulk_jobs WHERE id IN (
        SELECT id FROM mail_bulk_jobs
        WHERE status IN ('succeeded', 'partial', 'failed')
          AND created_at < NOW() - make_interval(days => ${RETENTION_DAYS})
        ORDER BY created_at
        LIMIT ${RETENTION_BATCH}
      ) RETURNING id
    `.execute(db);
    if (deleted.rows.length > 0) {
      logger.info('retention pruned {count} mail bulk job(s)', {
        component: 'mailjobs/sweep',
        count: deleted.rows.length,
      });
    }
  };
}
