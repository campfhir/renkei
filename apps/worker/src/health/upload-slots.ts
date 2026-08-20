/**
 * Upload slot hygiene, one hourly sweep with two duties:
 *
 * 1. Mark 'pending' slots past expires_at as 'expired' — the POST route's
 *    conditional claim already refuses them, but check_file_upload should
 *    report "expired" from the row itself, not recompute it forever.
 * 2. Prune terminal slots older than a day, in bounded batches. Slots are
 *    minted per upload and live 15 minutes; a day of history is plenty for
 *    "did my upload land" while keeping the table from accreting.
 */

import { sql, type Kysely } from 'kysely';
import type { DB } from '@renkei/db';
import { logger } from '../logger';

export const UPLOAD_SLOTS_SWEEP_INTERVAL_MS = 60 * 60_000;

/** Terminal rows older than this are pruned. */
const RETENTION_DAYS = 1;
const RETENTION_BATCH = 500;

export function createUploadSlotsSweep(db: Kysely<DB>) {
  return async function sweep(): Promise<void> {
    const expired = await db
      .updateTable('upload_slots')
      .set({ status: 'expired' })
      .where('status', '=', 'pending')
      .where('expires_at', '<', sql<Date>`NOW()`)
      .executeTakeFirst();
    const expiredCount = Number(expired.numUpdatedRows ?? 0);
    if (expiredCount > 0) {
      logger.info('expired {count} stale upload slot(s)', {
        component: 'uploadslots/sweep',
        count: expiredCount,
      });
    }

    const deleted = await sql<{ id: string }>`
      DELETE FROM upload_slots WHERE id IN (
        SELECT id FROM upload_slots
        WHERE status IN ('completed', 'failed', 'expired')
          AND created_at < NOW() - make_interval(days => ${RETENTION_DAYS})
        ORDER BY created_at
        LIMIT ${RETENTION_BATCH}
      ) RETURNING id
    `.execute(db);
    if (deleted.rows.length > 0) {
      logger.info('retention pruned {count} upload slot(s)', {
        component: 'uploadslots/sweep',
        count: deleted.rows.length,
      });
    }
  };
}
