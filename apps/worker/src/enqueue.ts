/**
 * Producer side of the embedding queue (Decision #20). Interactive
 * handlers and sweeps call this instead of embedding inline: the enqueue
 * is cheap and local, and the embedding worker — any number of instances —
 * does the network-bound work on its own clock.
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
 *                    accessSubject }
 *
 * Ordering is per KEY, not per queue: callers pass the ordering key that
 * names the sequence their messages must keep — a mailbox namespace for
 * Microsoft (purge before its re-ingests, deletes after ingests), an
 * object refId for WebEx/Zoom (a message's enrichment after its ingest).
 * Messages with different keys process in parallel across however many
 * embedding workers are running.
 */

import { embeddingQueue } from './queue';
import { logger } from './logger';

export const KNOWLEDGE_SOURCE = 'knowledge';

export type KnowledgeEventType =
  | 'ingest.object'
  | 'ingest.email'
  | 'delete.object'
  | 'purge.prefix'
  | 'enrich.item';

/**
 * Enqueue one knowledge job. A failed enqueue is logged and swallowed:
 * every call site sits inside a handler that has already done its
 * interactive work, and failing the whole event to retry one index write
 * would re-run side effects that must not repeat (posted replies, created
 * cards). The index self-heals on the next capture or sweep of the same
 * object — the same trade the old inline path made by logging and
 * continuing on embed failure.
 */
export async function enqueueKnowledgeEvent(
  tenantId: string,
  type: KnowledgeEventType,
  payload: Record<string, unknown>,
  orderingKey: string | null = null
): Promise<void> {
  const enqueued = await embeddingQueue.producer.enqueue({
    tenantId,
    source: KNOWLEDGE_SOURCE,
    type,
    payload,
    orderingKey,
  });
  if (!enqueued.ok) {
    logger.error('knowledge job {type} not enqueued: {error}', {
      component: 'worker/enqueue',
      type,
      tenantId,
      error: enqueued.err.message ?? 'unknown',
    });
  }
}
