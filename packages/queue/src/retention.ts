/**
 * Settled-row retention for the queue tables. A completed or skipped
 * message stays in its live table — the admin's event monitor reads the
 * outcome there — but nothing used to delete it, so a queue table grew for
 * as long as the deployment lived and every scan over it slowed with it.
 * This sweep deletes settled rows past SETTLED_RETENTION_DAYS, in bounded
 * batches, oldest first; dead letters are untouched (they are kept to be
 * read and requeued), and live rows never qualify.
 *
 * Replica-safe by construction: a bounded DELETE of rows that are done is
 * idempotent, so two sweeps at once cost a duplicate read and never a
 * wrong write.
 */

import { getDataStore, type QueueTable } from '@renkei/db';

/** How long a finished message stays readable on the event monitor. */
export const SETTLED_RETENTION_DAYS = 14;
export const SETTLED_RETENTION_SWEEP_MS = 60 * 60_000;

const BATCH = 1_000;
/** Batches per pass: a huge backlog clears over passes, not in one. */
const MAX_BATCHES_PER_PASS = 20;
const DAY_MS = 24 * 60 * 60_000;

export interface SettledRetentionLogger {
  info(message: string, attrs?: Record<string, unknown>): void;
}

export function createSettledRetentionSweep(options: {
  tables: readonly QueueTable[];
  logger: SettledRetentionLogger;
  component: string;
  retentionDays?: number;
  now?: () => number;
}) {
  const days = options.retentionDays ?? SETTLED_RETENTION_DAYS;
  const now = options.now ?? Date.now;
  return async function sweepSettledRows(): Promise<void> {
    const before = new Date(now() - days * DAY_MS);
    for (const table of options.tables) {
      let deleted = 0;
      for (let batch = 0; batch < MAX_BATCHES_PER_PASS; batch += 1) {
        const went = await getDataStore().queues.pruneSettled(table, before, BATCH);
        deleted += went;
        if (went < BATCH) break;
      }
      if (deleted > 0) {
        options.logger.info('pruned {count} settled {table} row(s) older than {days} days', {
          component: options.component,
          table,
          count: deleted,
          days,
        });
      }
    }
  };
}
