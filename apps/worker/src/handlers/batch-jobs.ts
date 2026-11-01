/**
 * The batch-job queue handlers: 'discover' (one message per batch — lists/
 * groups the source into items, then enqueues one 'item' message per item)
 * and 'item' (one message per unit of work — runs the batch's kind handler
 * on it and records the outcome). See batch-jobs/store.ts for the
 * crash-recovery guards both share, and batch-jobs/kinds.ts for the
 * per-kind discover()/runItem() contract.
 */

import type { QueueProducer } from '@renkei/queue';
import type { EventHandler } from '../handlers';
import { getBatchJobKind } from '../batch-jobs/kinds';
import * as store from '../batch-jobs/store';
import type { BatchJobRow } from '../batch-jobs/store';
import { enqueueItem } from '../batch-jobs/enqueue';
import { announceBatchFinished, announceBatchStarted } from '../batch-jobs/lifecycle';
import { logger } from '../logger';
import { isRecord } from '@renkei/guards';

const COMPONENT = 'batch-jobs/run';

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/**
 * Every terminal transition funnels through here: the store resolves to
 * the finalized row only for the one call that actually ended the batch,
 * and only that call announces it (owner notification + `batch/job.completed`
 * for agents). A redelivery or a lost race gets undefined and says nothing.
 */
async function finalize(transition: Promise<BatchJobRow | undefined>): Promise<void> {
  const finished = await transition;
  if (finished) await announceBatchFinished(finished);
}

export function createBatchDiscoverHandler(producer: QueueProducer): EventHandler {
  return async (event) => {
    const payload: unknown = event.payload;
    const batchJobId = isRecord(payload) ? str(payload.batchJobId) : '';

    const batch = batchJobId ? await store.getBatch(batchJobId) : undefined;
    if (!batch) {
      logger.warn('batch {batchJobId} not found; dropping discover message', {
        component: COMPONENT,
        batchJobId: batchJobId || '(missing)',
      });
      return;
    }

    if (batch.status !== 'queued') {
      if (batch.status === 'discovering') {
        // A previous delivery died mid-discovery — do NOT re-run (would
        // create duplicate items). Finalize and let the caller start over.
        await finalize(store.failBatch(batch.id, 'worker restarted mid-discovery'));
        logger.warn('batch {batchJobId} failed: {error}', {
          component: COMPONENT,
          batchJobId: batch.id,
          kind: batch.kind,
          subject: batch.subject,
          error: 'worker restarted mid-discovery',
        });
      }
      return; // Terminal, or just finalized: a redelivery is an idempotent no-op.
    }

    const claimed = await store.beginDiscovery(batch.id);
    if (!claimed) return; // Lost the claim race to a concurrent delivery.
    // The claim is the moment the batch begins work — and the one moment
    // it begins, so "started" is announced exactly once too.
    await announceBatchStarted(claimed);

    const kind = getBatchJobKind(claimed.kind);
    if (!kind) {
      await finalize(store.failBatch(claimed.id, `Unknown batch kind "${claimed.kind}".`));
      logger.warn('batch {batchJobId} failed: {error}', {
        component: COMPONENT,
        batchJobId: claimed.id,
        kind: claimed.kind,
        subject: claimed.subject,
        error: `Unknown batch kind "${claimed.kind}".`,
      });
      return;
    }

    let discovered: Awaited<ReturnType<typeof kind.discover>>;
    try {
      discovered = await kind.discover(claimed);
    } catch (error) {
      logger.error('batch {batchJobId} discovery threw: {error}', {
        component: COMPONENT,
        batchJobId: claimed.id,
        kind: claimed.kind,
        subject: claimed.subject,
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      });
      await finalize(
        store.failBatch(claimed.id, error instanceof Error ? error.message : String(error))
      );
      return;
    }
    if (!discovered.ok) {
      logger.warn('batch {batchJobId} failed: {error}', {
        component: COMPONENT,
        batchJobId: claimed.id,
        kind: claimed.kind,
        subject: claimed.subject,
        error: discovered.error ?? 'Discovery failed.',
      });
      await finalize(store.failBatch(claimed.id, discovered.error ?? 'Discovery failed.'));
      return;
    }

    const items = discovered.items ?? [];
    const skippedItems = discovered.skipped ?? [];

    // What discovery decided not to run is still written down — as items
    // the batch page can list under "Skipped" with their reason — it is
    // just never enqueued, and never counted as work to wait for.
    for (const itemPayload of skippedItems) {
      await store.insertItem(claimed.id, itemPayload, {
        status: 'skipped',
        result: { skipped: true, reason: str(itemPayload.skipReason) || 'already-processed' },
      });
    }

    if (items.length === 0) {
      await finalize(store.completeEmptyBatch(claimed.id, skippedItems.length));
      return;
    }

    // One round trip per item (insert, then enqueue its message) — a mid-loop
    // crash leaves a consistent prefix: every item created so far is already
    // enqueued. Sequential on purpose at this scale (thousands, not millions);
    // chunk this if a batch's discovery phase becomes the bottleneck.
    let created = 0;
    for (const itemPayload of items) {
      const item = await store.insertItem(claimed.id, itemPayload);
      await enqueueItem(producer, claimed.id, item.id);
      created += 1;
    }
    // Activation can itself be the terminal transition when every item
    // already landed — see activateBatch — so it goes through finalize too.
    await finalize(
      store.activateBatch(claimed.id, created + skippedItems.length, skippedItems.length)
    );
    logger.info('batch {batchJobId} discovered {count} item(s), skipped {skipped}', {
      component: COMPONENT,
      batchJobId: claimed.id,
      count: created,
      skipped: skippedItems.length,
    });
  };
}

export function createBatchItemHandler(): EventHandler {
  return async (event) => {
    const payload: unknown = event.payload;
    const batchJobId = isRecord(payload) ? str(payload.batchJobId) : '';
    const itemId = isRecord(payload) ? str(payload.itemId) : '';

    const batch = batchJobId ? await store.getBatch(batchJobId) : undefined;
    const item = itemId ? await store.getItem(itemId) : undefined;
    if (!batch || !item || item.batch_id !== batch.id) {
      logger.warn('batch item {itemId} not found; dropping message', {
        component: COMPONENT,
        batchJobId: batchJobId || '(missing)',
        itemId: itemId || '(missing)',
      });
      return;
    }

    if (item.status !== 'pending') {
      if (item.status === 'processing') {
        // A previous delivery died mid-item. Do NOT re-run — the kind's
        // item work may bill per call (OCR does) — finalize as failed.
        await finalize(
          store.recordItemOutcome(batch.id, item.id, {
            ok: false,
            error: 'worker restarted mid-item',
          })
        );
        logger.warn('batch {batchJobId} item {itemId} failed: worker restarted mid-item', {
          component: COMPONENT,
          batchJobId: batch.id,
          itemId: item.id,
          kind: batch.kind,
          subject: batch.subject,
        });
      }
      return; // Terminal: a redelivery is an idempotent no-op.
    }

    const claimed = await store.claimItem(item.id);
    if (!claimed) return; // Lost the claim race to a concurrent delivery.

    const kind = getBatchJobKind(batch.kind);
    if (!kind) {
      await finalize(
        store.recordItemOutcome(batch.id, claimed.id, {
          ok: false,
          error: `Unknown batch kind "${batch.kind}".`,
        })
      );
      logger.error('batch {batchJobId}: unknown batch kind "{kind}"', {
        component: COMPONENT,
        batchJobId: batch.id,
        kind: batch.kind,
        subject: batch.subject,
      });
      return;
    }

    let outcome: store.ItemOutcome;
    try {
      outcome = await kind.runItem(batch, claimed);
    } catch (error) {
      outcome = { ok: false, error: error instanceof Error ? error.message : String(error) };
      logger.error('batch {batchJobId} item {itemId} threw: {error}', {
        component: COMPONENT,
        batchJobId: batch.id,
        itemId: claimed.id,
        kind: batch.kind,
        subject: batch.subject,
        error: outcome.error,
        stack: error instanceof Error ? error.stack : undefined,
      });
    }
    if (!outcome.ok) {
      // The item row keeps the reason too, but only the log reaches Activity.
      logger.warn('batch {batchJobId} item {itemId} failed: {error}', {
        component: COMPONENT,
        batchJobId: batch.id,
        itemId: claimed.id,
        kind: batch.kind,
        subject: batch.subject,
        error: outcome.error,
      });
    }
    // Whichever item lands last finalizes the batch and announces it —
    // `finalize` is outside the try so an announcement problem is never
    // recorded as the item having failed.
    await finalize(store.recordItemOutcome(batch.id, claimed.id, outcome));
  };
}
