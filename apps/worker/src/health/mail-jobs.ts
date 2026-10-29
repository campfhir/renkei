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

import { getDataStore } from '@renkei/db';
import { logger } from '../logger';

export const MAIL_JOBS_SWEEP_INTERVAL_MS = 60 * 60_000;

/** Silence longer than this on a running job = the worker died mid-run. */
const STALL_MINUTES = 60;
/** Terminal rows older than this are pruned. */
const RETENTION_DAYS = 30;
const RETENTION_BATCH = 500;

export function createMailJobsSweep() {
  return async function sweep(): Promise<void> {
    const store = getDataStore();
    const stalledCount = await store.mailBulkJobs.failStalled(
      STALL_MINUTES,
      'job stalled; the worker likely restarted mid-run'
    );
    if (stalledCount > 0) {
      logger.warn('failed {count} stalled mail bulk job(s)', {
        component: 'mailjobs/sweep',
        count: stalledCount,
      });
    }

    const deleted = await store.mailBulkJobs.pruneFinished(RETENTION_DAYS, RETENTION_BATCH);
    if (deleted > 0) {
      logger.info('retention pruned {count} mail bulk job(s)', {
        component: 'mailjobs/sweep',
        count: deleted,
      });
    }
  };
}
