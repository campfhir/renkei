/**
 * Sent-ledger hygiene. `webex_sent_messages` rows exist so the all-spaces
 * ingest can tell a message Renkei posted from one the watcher typed
 * (handlers/webex-user-message.ts); they only need to outlive the window in
 * which a webhook could still deliver the message they describe — queue
 * redelivery plus a duplicate registration's second delivery.
 *
 * A week, matching the trigger-firing ledger, and pruned in bounded batches
 * for the same reason: a single unbounded DELETE over a busy tenant's
 * history is a lock nobody asked for.
 */

import { sql, type Kysely } from 'kysely';
import type { DB } from '@renkei/db';
import { logger } from '../logger';

export const WEBEX_SENT_SWEEP_INTERVAL_MS = 60 * 60_000;

/** Rows older than this are pruned. */
const RETENTION_DAYS = 7;
const RETENTION_BATCH = 1000;

export function createWebexSentSweep(db: Kysely<DB>) {
  return async function sweep(): Promise<void> {
    const deleted = await sql<{ message_id: string }>`
      DELETE FROM webex_sent_messages WHERE (tenant_id, message_id) IN (
        SELECT tenant_id, message_id FROM webex_sent_messages
        WHERE created_at < NOW() - make_interval(days => ${RETENTION_DAYS})
        ORDER BY created_at
        LIMIT ${RETENTION_BATCH}
      ) RETURNING message_id
    `.execute(db);
    if (deleted.rows.length > 0) {
      logger.info('retention pruned {count} sent WebEx message record(s)', {
        component: 'webexsent/sweep',
        count: deleted.rows.length,
      });
    }
  };
}
