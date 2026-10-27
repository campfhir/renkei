/**
 * One replica per sweep: the provider-facing sweeps (WebEx webhooks,
 * Microsoft subscriptions, content watches) are list-then-create against an
 * external system, so two worker processes running one concurrently can
 * both see "missing" and both create — duplicate WebEx webhooks were
 * double-delivering every message. An advisory lock elects a single runner
 * per pass (`getDataStore().advisoryLocks`: a Postgres session-level
 * advisory lock taken and released on one pinned connection); the losers
 * skip and try again next interval, which is exactly the cadence they
 * would have kept anyway.
 *
 * The purely DB-side hygiene sweeps (mail jobs, upload slots, firings) stay
 * unwrapped: their statements are idempotent, so concurrent passes are
 * merely redundant, never wrong.
 */

import { getDataStore } from '@renkei/db';
import { logger } from '../logger';

/** Namespace half of the two-int advisory key, so other tools' locks can't collide. */
const LOCK_NAMESPACE = 'renkei-sweep';

/** Wrap a sweep so that only one worker process runs it at a time. */
export function withSweepLock(name: string, fn: () => Promise<void>): () => Promise<void> {
  return async () => {
    // The sweep's own failure propagates; a lock that could not be taken
    // at all (the database is down) skips the pass with a log line.
    let sweepFailed = false;
    let ran: boolean;
    try {
      ran = await getDataStore().advisoryLocks.withTryLock(LOCK_NAMESPACE, name, async () => {
        try {
          await fn();
        } catch (error) {
          sweepFailed = true;
          throw error;
        }
      });
    } catch (error) {
      if (sweepFailed) throw error;
      logger.error('database unavailable; skipping {sweep}', {
        component: 'worker/sweep-lock',
        sweep: name,
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    if (!ran) {
      logger.debug('another worker holds the {sweep} lock; skipping this pass', {
        component: 'worker/sweep-lock',
        sweep: name,
      });
    }
  };
}
