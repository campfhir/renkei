/**
 * The Renkei batch-jobs worker — consumes the `batch_job_messages` queue
 * (packages/db/src/migrations/077-*).
 *
 * Its own process, the embeddings-worker precedent: batch-job item work
 * (OCR calls, and whatever future kinds add) is slow, external, per-item
 * network I/O, so it never sits in front of the interactive worker's
 * webhook replies. Scale this process horizontally at will — claims are
 * row-locked, and each batch's own source lane (`batch:{batchJobId}`)
 * keeps one huge batch from starving a smaller concurrent one without
 * serializing the huge batch's own items against each other.
 */

import { closeDatabase, getDatabase } from '@renkei/db';
import { schedulePeriodicSweep } from '@renkei/worker-loop';
import { batchJobQueue } from './queue';
import { handlerFor, registerHandler } from './handlers';
import { createEventLoop } from './loop';
import { createBatchDiscoverHandler, createBatchItemHandler } from './handlers/batch-jobs';
import { BATCH_JOB_SOURCE } from './batch-jobs/enqueue';
import { createBatchScheduleSweep } from './batch-jobs/schedule-sweep';
import './batch-jobs/register-kinds';
import { logger, attachPersistentLogging } from './logger';

// Same cadence as the agents worker's schedule sweep — a due batch job
// fires within ~15s on average, cheap since the sweep is one indexed
// select plus optimistic updates.
const SCHEDULE_SWEEP_MS = 30_000;

function registerBatchJobHandlers(): void {
  registerHandler(BATCH_JOB_SOURCE, 'discover', createBatchDiscoverHandler(batchJobQueue.producer));
  registerHandler(BATCH_JOB_SOURCE, 'item', createBatchItemHandler());
  logger.info('batch-job handlers registered', { component: 'worker/batch-jobs-loop' });
}

const loop = createEventLoop({
  claim: () => batchJobQueue.consumer.claim(),
  complete: (event, outcome) => batchJobQueue.consumer.complete(event, outcome),
  fail: (event, error) => batchJobQueue.consumer.fail(event, error),
  handlerFor,
  label: 'worker/batch-jobs-loop',
});

async function main(): Promise<void> {
  await attachPersistentLogging();
  registerBatchJobHandlers();

  const dbResult = getDatabase();
  if (!dbResult.ok) throw new Error('Database unavailable at boot');

  // The schedule sweep runs on its own timer, independent of the queue
  // consumption loop below — a quiet queue never delays a due schedule.
  const stopSweep = schedulePeriodicSweep(
    logger,
    'batch job schedules',
    'worker/batch-jobs-schedule',
    SCHEDULE_SWEEP_MS,
    createBatchScheduleSweep(dbResult.val, batchJobQueue.producer)
  );

  logger.info('started {application} {version} (batch-job queue)', {
    component: 'worker/batch-jobs-loop',
  });
  await loop.run();
  stopSweep();
  logger.info('stopped', { component: 'worker/batch-jobs-loop' });
  await logger.flush();
  await closeDatabase();
}

function shutdown(signal: string): void {
  logger.info('{signal} received, finishing current event', {
    component: 'worker/batch-jobs-loop',
    signal,
  });
  loop.stop();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

void main();
