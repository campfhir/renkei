/**
 * Producer side of the batch-job item queue (batch_job_messages). Every
 * message is tagged source `batch:{batchJobId}` — the embedding_jobs
 * provider-lane precedent, applied per batch instead of per connector, so
 * one huge batch's items can't starve a smaller concurrent batch's. The
 * handler dispatch (apps/worker/src/handlers.ts's colon-fallback) routes
 * both lanes to the same registered handler regardless of which batch
 * tagged them.
 */

import type { QueueProducer } from '@renkei/queue';

export const BATCH_JOB_SOURCE = 'batch';

export async function enqueueDiscover(
  producer: QueueProducer,
  tenantId: string,
  batchJobId: string
): Promise<void> {
  const enqueued = await producer.enqueue({
    tenantId,
    source: `${BATCH_JOB_SOURCE}:${batchJobId}`,
    type: 'discover',
    payload: { batchJobId },
  });
  if (!enqueued.ok) throw new Error(`could not enqueue discovery for batch ${batchJobId}`);
}

export async function enqueueItem(
  producer: QueueProducer,
  tenantId: string,
  batchJobId: string,
  itemId: string
): Promise<void> {
  const enqueued = await producer.enqueue({
    tenantId,
    source: `${BATCH_JOB_SOURCE}:${batchJobId}`,
    type: 'item',
    payload: { batchJobId, itemId },
  });
  if (!enqueued.ok) throw new Error(`could not enqueue item ${itemId} for batch ${batchJobId}`);
}
