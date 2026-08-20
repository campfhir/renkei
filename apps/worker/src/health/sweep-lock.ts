/**
 * One replica per sweep: the provider-facing sweeps (WebEx webhooks,
 * Microsoft subscriptions, content watches) are list-then-create against an
 * external system, so two worker processes running one concurrently can
 * both see "missing" and both create — duplicate WebEx webhooks were
 * double-delivering every message. A Postgres advisory lock elects a single
 * runner per pass; the losers skip and try again next interval, which is
 * exactly the cadence they would have kept anyway.
 *
 * Session-level (not transaction-level) locks, taken and released on ONE
 * pinned pool connection — an advisory lock belongs to the connection that
 * took it, so acquiring and releasing through the pool at large would
 * unlock some other session's lock (or nothing).
 *
 * The purely DB-side hygiene sweeps (mail jobs, upload slots, firings) stay
 * unwrapped: their statements are idempotent, so concurrent passes are
 * merely redundant, never wrong.
 */

import { sql } from 'kysely';
import { getDatabase } from '@renkei/db';
import { logger } from '../logger';

/** Namespace half of the two-int advisory key, so other tools' locks can't collide. */
const LOCK_NAMESPACE = 'renkei-sweep';

/** Wrap a sweep so that only one worker process runs it at a time. */
export function withSweepLock(name: string, fn: () => Promise<void>): () => Promise<void> {
  return async () => {
    const dbResult = getDatabase();
    if (!dbResult.ok) {
      logger.error('database unavailable; skipping {sweep}', {
        component: 'worker/sweep-lock',
        sweep: name,
      });
      return;
    }
    await dbResult.val.connection().execute(async (conn) => {
      const locked = await sql<{ locked: boolean }>`
        SELECT pg_try_advisory_lock(hashtext(${LOCK_NAMESPACE}), hashtext(${name})) AS locked
      `.execute(conn);
      if (!locked.rows[0]?.locked) {
        logger.debug('another worker holds the {sweep} lock; skipping this pass', {
          component: 'worker/sweep-lock',
          sweep: name,
        });
        return;
      }
      try {
        await fn();
      } finally {
        await sql`
          SELECT pg_advisory_unlock(hashtext(${LOCK_NAMESPACE}), hashtext(${name}))
        `.execute(conn);
      }
    });
  };
}
