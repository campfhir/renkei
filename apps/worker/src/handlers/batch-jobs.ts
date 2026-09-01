/**
 * The batch-job queue handlers: 'discover' (one message per batch — lists/
 * groups the source into items, then enqueues one 'item' message per item)
 * and 'item' (one message per unit of work — runs the batch's kind handler
 * on it and records the outcome). See batch-jobs/store.ts for the
 * crash-recovery guards both share, and batch-jobs/kinds.ts for the
 * per-kind discover()/runItem() contract.
 */

import { getDatabase } from '@renkei/db';
import type { QueueProducer } from '@renkei/queue';
import type { EventHandler } from '../handlers';
import { getBatchJobKind } from '../batch-jobs/kinds';
import * as store from '../batch-jobs/store';
import { enqueueItem } from '../batch-jobs/enqueue';
import { logger } from '../logger';

const COMPONENT = 'batch-jobs/run';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

export function createBatchDiscoverHandler(producer: QueueProducer): EventHandler {
  return async (event) => {
    const payload: unknown = event.payload;
    const batchJobId = isRecord(payload) ? str(payload.batchJobId) : '';
    const dbResult = getDatabase();
    if (!dbResult.ok) throw new Error('database unavailable for batch discovery');
    const db = dbResult.val;

    const batch = batchJobId ? await store.getBatch(db, batchJobId, event.tenant_id) : undefined;
    if (!batch) {
      logger.warn('batch {batchJobId} not found; dropping discover message', {
        component: COMPONENT,
        tenantId: event.tenant_id,
        batchJobId: batchJobId || '(missing)',
      });
      return;
    }

    if (batch.status !== 'queued') {
      if (batch.status === 'discovering') {
        // A previous delivery died mid-discovery — do NOT re-run (would
        // create duplicate items). Finalize and let the caller start over.
        await store.failBatch(db, batch.id, 'worker restarted mid-discovery');
      }
      return; // Terminal, or just finalized: a redelivery is an idempotent no-op.
    }

    const claimed = await store.beginDiscovery(db, batch.id);
    if (!claimed) return; // Lost the claim race to a concurrent delivery.

    const kind = getBatchJobKind(claimed.kind);
    if (!kind) {
      await store.failBatch(db, claimed.id, `Unknown batch kind "${claimed.kind}".`);
      return;
    }

    let discovered: Awaited<ReturnType<typeof kind.discover>>;
    try {
      discovered = await kind.discover(db, claimed);
    } catch (error) {
      await store.failBatch(
        db,
        claimed.id,
        error instanceof Error ? error.message : String(error)
      );
      return;
    }
    if (!discovered.ok) {
      await store.failBatch(db, claimed.id, discovered.error ?? 'Discovery failed.');
      return;
    }

    const items = discovered.items ?? [];
    if (items.length === 0) {
      await store.completeEmptyBatch(db, claimed.id);
      return;
    }

    // One round trip per item (insert, then enqueue its message) — a mid-loop
    // crash leaves a consistent prefix: every item created so far is already
    // enqueued. Sequential on purpose at this scale (thousands, not millions);
    // chunk this if a batch's discovery phase becomes the bottleneck.
    let created = 0;
    for (const itemPayload of items) {
      const item = await store.insertItem(db, claimed.id, itemPayload);
      await enqueueItem(producer, event.tenant_id, claimed.id, item.id);
      created += 1;
    }
    await store.activateBatch(db, claimed.id, created);
    logger.info('batch {batchJobId} discovered {count} item(s)', {
      component: COMPONENT,
      tenantId: event.tenant_id,
      batchJobId: claimed.id,
      count: created,
    });
  };
}

export function createBatchItemHandler(): EventHandler {
  return async (event) => {
    const payload: unknown = event.payload;
    const batchJobId = isRecord(payload) ? str(payload.batchJobId) : '';
    const itemId = isRecord(payload) ? str(payload.itemId) : '';
    const dbResult = getDatabase();
    if (!dbResult.ok) throw new Error('database unavailable for batch item');
    const db = dbResult.val;

    const batch = batchJobId ? await store.getBatch(db, batchJobId, event.tenant_id) : undefined;
    const item = itemId ? await store.getItem(db, itemId) : undefined;
    if (!batch || !item || item.batch_id !== batch.id) {
      logger.warn('batch item {itemId} not found; dropping message', {
        component: COMPONENT,
        tenantId: event.tenant_id,
        batchJobId: batchJobId || '(missing)',
        itemId: itemId || '(missing)',
      });
      return;
    }

    if (item.status !== 'pending') {
      if (item.status === 'processing') {
        // A previous delivery died mid-item. Do NOT re-run — the kind's
        // item work may bill per call (OCR does) — finalize as failed.
        await store.recordItemOutcome(db, batch.id, item.id, {
          ok: false,
          error: 'worker restarted mid-item',
        });
      }
      return; // Terminal: a redelivery is an idempotent no-op.
    }

    const claimed = await store.claimItem(db, item.id);
    if (!claimed) return; // Lost the claim race to a concurrent delivery.

    const kind = getBatchJobKind(batch.kind);
    if (!kind) {
      await store.recordItemOutcome(db, batch.id, claimed.id, {
        ok: false,
        error: `Unknown batch kind "${batch.kind}".`,
      });
      return;
    }

    try {
      const outcome = await kind.runItem(db, batch, claimed);
      await store.recordItemOutcome(db, batch.id, claimed.id, outcome);
    } catch (error) {
      await store.recordItemOutcome(db, batch.id, claimed.id, {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };
}
