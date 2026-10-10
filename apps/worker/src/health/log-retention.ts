/**
 * Log retention: purge bored-logs rows past the org's `logRetentionDays`
 * dial.
 *
 * Batched the same way bored-logs' own purge does: one short atomic
 * statement per batch. The `batch` CTE captures up to BATCH_SIZE matching
 * log ids once; the three DELETEs that follow all read that same captured
 * set (a WITH clause's siblings share one snapshot in Postgres), so every
 * delete targets exactly those rows and nothing can be half-deleted or
 * double-counted across the blob/attribute/log tables. Capped per pass so
 * a huge backlog cannot hold the sweep open indefinitely — the remainder
 * is picked up on the next pass, LOG_RETENTION_SWEEP_INTERVAL_MS later.
 */

import { sql } from 'kysely';
import { getDatabase } from '@renkei/db';
import { getOrgSettings } from '@renkei/settings';
import { logger } from '../logger';

const COMPONENT = 'logs/retention-sweep';

export const LOG_RETENTION_SWEEP_INTERVAL_MS = 6 * 60 * 60_000;

/** Rows deleted per atomic batch — the same order of magnitude as bored-logs' own purge batches. */
const BATCH_SIZE = 2_000;

/**
 * Cap per pass: at most this many batches, so a huge backlog cannot hold
 * the sweep open indefinitely. The remainder waits for the next pass.
 */
const MAX_BATCHES_PER_PASS = 50;

export async function sweepLogRetention(): Promise<void> {
  const dbResult = getDatabase();
  if (!dbResult.ok) return;
  const db = dbResult.val;

  /**
   * Delete one batch of log rows logged at or before `until`. Returns the
   * number of `logs` rows removed — fewer than BATCH_SIZE means there is
   * nothing left to purge.
   */
  async function purgeBatch(until: Date): Promise<number> {
    const result = await sql<{ deleted: string }>`
      WITH batch AS (
        SELECT log_id FROM logs
        WHERE logged_timestamp <= ${until}
        LIMIT ${BATCH_SIZE}
      ),
      del_blob AS (
        DELETE FROM log_attr_blob WHERE log_id IN (SELECT log_id FROM batch)
      ),
      del_attr AS (
        DELETE FROM log_attr WHERE log_id IN (SELECT log_id FROM batch)
      ),
      del_logs AS (
        DELETE FROM logs WHERE log_id IN (SELECT log_id FROM batch)
      )
      SELECT count(*)::text AS deleted FROM batch
    `.execute(db);
    return Number(result.rows[0]?.deleted ?? 0);
  }

  /** Purge rows past `until`, in batches, up to the per-pass cap. */
  async function purge(until: Date): Promise<number> {
    let total = 0;
    for (let i = 0; i < MAX_BATCHES_PER_PASS; i++) {
      const deleted = await purgeBatch(until);
      total += deleted;
      if (deleted < BATCH_SIZE) break;
    }
    return total;
  }

  const settings = await getOrgSettings();
  const days = settings.ok ? settings.val.logRetentionDays : 0;
  // 0 (or unreadable) = logs are kept forever.
  if (days <= 0) return;

  const until = new Date(Date.now() - days * 24 * 60 * 60_000);
  try {
    const deleted = await purge(until);
    if (deleted > 0) {
      logger.info('purged {deleted} log row(s) older than {days} day(s)', {
        component: COMPONENT,
        deleted,
        days,
      });
    }
  } catch (error) {
    logger.error('log purge failed: {error}', {
      component: COMPONENT,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
