/**
 * Retention for the queue tables. A completed or skipped message stays in
 * its live table — the admin's event monitor reads the outcome there — but
 * nothing used to delete it, so a queue table grew for as long as the
 * deployment lived and every scan over it slowed with it. This sweep
 * deletes settled rows past SETTLED_RETENTION_DAYS and dead letters past
 * DEAD_LETTER_RETENTION_DAYS, in bounded batches, oldest first. Live rows
 * never qualify; a dead letter inside its window stays to be read and
 * requeued, which is what the dead-letter store is for.
 *
 * Replica-safe by construction: a bounded DELETE of rows that are done is
 * idempotent, so two sweeps at once cost a duplicate read and never a
 * wrong write.
 */

import { getDataStore, type QueueTable } from '@renkei/db';

/** How long a finished message stays readable on the event monitor. */
export const SETTLED_RETENTION_DAYS = 14;
/** How long a dead letter waits to be requeued or purged before it is dropped. */
export const DEAD_LETTER_RETENTION_DAYS = 30;
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
  deadLetterRetentionDays?: number;
  now?: () => number;
}) {
  const days = options.retentionDays ?? SETTLED_RETENTION_DAYS;
  const deadDays = options.deadLetterRetentionDays ?? DEAD_LETTER_RETENTION_DAYS;
  const now = options.now ?? Date.now;

  /** Delete by `prune` in batches up to the per-pass cap; how many went. */
  async function drain(prune: (limit: number) => Promise<number>): Promise<number> {
    let deleted = 0;
    for (let batch = 0; batch < MAX_BATCHES_PER_PASS; batch += 1) {
      const went = await prune(BATCH);
      deleted += went;
      if (went < BATCH) break;
    }
    return deleted;
  }

  return async function sweepQueueRetention(): Promise<void> {
    const settledBefore = new Date(now() - days * DAY_MS);
    const deadBefore = new Date(now() - deadDays * DAY_MS);
    for (const table of options.tables) {
      const queues = getDataStore().queues;
      const settled = await drain((limit) => queues.pruneSettled(table, settledBefore, limit));
      if (settled > 0) {
        options.logger.info('pruned {count} settled {table} row(s) older than {days} days', {
          component: options.component,
          table,
          count: settled,
          days,
        });
      }
      const dead = await drain((limit) => queues.pruneDeadLetters(table, deadBefore, limit));
      if (dead > 0) {
        options.logger.info('pruned {count} {table} dead letter(s) older than {days} days', {
          component: options.component,
          table,
          count: dead,
          days: deadDays,
        });
      }
    }
  };
}
