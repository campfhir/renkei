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

import { getDataStore } from '@renkei/db';
import { logger } from '../logger';

export const UPLOAD_SLOTS_SWEEP_INTERVAL_MS = 60 * 60_000;

/** Terminal rows older than this are pruned. */
const RETENTION_DAYS = 1;
const RETENTION_BATCH = 500;

export function createUploadSlotsSweep() {
  return async function sweep(): Promise<void> {
    const store = getDataStore();
    const expiredCount = await store.uploadSlots.expireStale();
    if (expiredCount > 0) {
      logger.info('expired {count} stale upload slot(s)', {
        component: 'uploadslots/sweep',
        count: expiredCount,
      });
    }

    const deleted = await store.uploadSlots.pruneSettled(RETENTION_DAYS, RETENTION_BATCH);
    if (deleted > 0) {
      logger.info('retention pruned {count} upload slot(s)', {
        component: 'uploadslots/sweep',
        count: deleted,
      });
    }
  };
}
