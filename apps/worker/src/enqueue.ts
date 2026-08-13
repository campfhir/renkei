/**
 * Producer side of the embedding lane (Decision #20). Interactive handlers
 * and sweeps call this instead of embedding inline: the INSERT is cheap and
 * local, and the embedding worker — the only consumer of the 'embedding'
 * lane — does the network-bound work on its own clock.
 *
 * Payload shapes, by type (all consumed in handlers/knowledge-ingest.ts):
 *
 *   ingest.object  { provider, refId, content, metadata, sourceAt,
 *                    chunking?: { maxChars, overlap } }
 *   ingest.email   { refId, ownerUpn, accountId?, raw: RawEmail,
 *                    metadata, sourceAt, override? }
 *   delete.object  { provider, refId }
 *   purge.prefix   { provider, refIdPrefix }
 *   enrich.item    { itemId, provider: 'webex', refId, query,
 *                    accessSubject, roomId, messageId }
 *
 * Ordering matters and holds by construction: the lane is FIFO and consumed
 * by a single embedding worker, so a purge enqueued before its re-ingests
 * runs first, and an enrich.item enqueued after its message's ingest.object
 * searches an index that already contains the message.
 */

import { randomUUID } from 'node:crypto';
import { getDatabase } from '@renkei/db';
import { logger } from './logger';

export const KNOWLEDGE_SOURCE = 'knowledge';

export type KnowledgeEventType =
  | 'ingest.object'
  | 'ingest.email'
  | 'delete.object'
  | 'purge.prefix'
  | 'enrich.item';

/**
 * INSERT one knowledge event into the embedding lane. A failed INSERT is
 * logged and swallowed: every enqueue site sits inside a handler that has
 * already done its interactive work, and failing the whole event to retry
 * one index write would re-run side effects that must not repeat (posted
 * replies, created cards). The index self-heals on the next capture or
 * sweep of the same object — the same trade the old inline path made by
 * logging and continuing on embed failure.
 */
export async function enqueueKnowledgeEvent(
  tenantId: string,
  type: KnowledgeEventType,
  payload: Record<string, unknown>
): Promise<void> {
  const dbResult = getDatabase();
  if (!dbResult.ok) {
    logger.error('knowledge event {type} not enqueued: database unavailable', {
      component: 'worker/enqueue',
      type,
      tenantId,
    });
    return;
  }
  try {
    await dbResult.val
      .insertInto('events')
      .values({
        id: randomUUID(),
        tenant_id: tenantId,
        source: KNOWLEDGE_SOURCE,
        type,
        payload: JSON.stringify(payload),
        lane: 'embedding',
      })
      .execute();
  } catch (error) {
    logger.error('knowledge event {type} not enqueued: {error}', {
      component: 'worker/enqueue',
      type,
      tenantId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
