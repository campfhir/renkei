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
 *   ingest.document{ provider, refId, accountId, driveId, itemId, name,
 *                    mimeType, size, cTag, webUrl, path, scopeKey,
 *                    scopeLabel, sourceAt, syncEpoch }
 *   delete.object  { provider, refId }
 *   purge.prefix   { provider, refIdPrefix }
 *   reconcile.drive{ provider, driveId, syncEpoch }
 *   enrich.item    { itemId, provider: 'webex', refId, query,
 *                    accessSubject }
 *
 * `ingest.document` deliberately carries IDENTIFIERS, not bytes. A 20MB file
 * base64'd into a jsonb payload would be TOASTed, WAL-replicated and kept in
 * the dead-letter table indefinitely, and downloading inside the sync round
 * would outlive the queue's claim lease on any large library. The embedding
 * worker re-downloads for itself.
 *
 * Ordering is per KEY, not per queue: callers pass the ordering key that
 * names the sequence their messages must keep — a mailbox namespace for
 * Microsoft (purge before its re-ingests, deletes after ingests), an
 * object refId for WebEx/Zoom (a message's enrichment after its ingest).
 * Messages with different keys process in parallel across however many
 * embedding workers are running.
 */

import { contentEncryptionKey, encryptContent } from '@renkei/crypto';
import { embeddingQueue } from './queue';
import { logger } from './logger';

export const KNOWLEDGE_SOURCE = 'knowledge';

export type KnowledgeEventType =
  | 'ingest.object'
  | 'ingest.email'
  | 'ingest.document'
  | 'delete.object'
  | 'purge.prefix'
  | 'reconcile.drive'
  | 'enrich.item';

/**
 * Enqueue one knowledge job. A failed enqueue is logged and swallowed:
 * every call site sits inside a handler that has already done its
 * interactive work, and failing the whole event to retry one index write
 * would re-run side effects that must not repeat (posted replies, created
 * cards). The index self-heals on the next capture or sweep of the same
 * object — the same trade the old inline path made by logging and
 * continuing on embed failure.
 *
 * `strict: true` inverts that: the enqueue failure throws. For call sites
 * where nothing irreversible has happened yet (the dispatch handler
 * enqueues knowledge BEFORE agent fan-out) and no later sweep would
 * re-capture the object, retrying the event is strictly better than
 * silently losing it from the index.
 */
/**
 * The payload fields that carry CONTENT, by type — encrypted at rest in the
 * queue row (and its dead-letter copy) and decrypted by the consumer right
 * before use. Everything else in the payload is identifiers and routing
 * metadata, which stays plaintext because reindex's discardPending and the
 * fairness lanes match on it. `raw` (a whole RawEmail object) rides as one
 * encrypted JSON string.
 */
const CONTENT_FIELDS: Partial<Record<KnowledgeEventType, readonly string[]>> = {
  'ingest.object': ['content'],
  'ingest.email': ['raw'],
  'enrich.item': ['query'],
};

function withEncryptedContent(
  type: KnowledgeEventType,
  payload: Record<string, unknown>
): Record<string, unknown> | null {
  const fields = CONTENT_FIELDS[type];
  if (!fields) return payload;
  const keyResult = contentEncryptionKey();
  if (!keyResult.ok) {
    // Refusing to enqueue beats silently queuing plaintext: the caller's
    // failure path logs it, and the sweep re-captures the object once the
    // key is configured. (TOKEN_ENCRYPTION_KEY is the fallback, so this is
    // effectively unreachable in a working deployment.)
    return null;
  }
  const out: Record<string, unknown> = { ...payload };
  for (const field of fields) {
    const value = out[field];
    if (value === undefined) continue;
    out[field] = encryptContent(
      typeof value === 'string' ? value : JSON.stringify(value),
      keyResult.val
    );
  }
  return out;
}

export async function enqueueKnowledgeEvent(
  tenantId: string,
  type: KnowledgeEventType,
  payload: Record<string, unknown>,
  orderingKey: string | null = null,
  options: { strict?: boolean } = {}
): Promise<void> {
  const encrypted = withEncryptedContent(type, payload);
  if (encrypted === null) {
    const message = 'content encryption key unavailable';
    if (options.strict) throw new Error(`knowledge job ${type} not enqueued: ${message}`);
    logger.error('knowledge job {type} not enqueued: {error}', {
      component: 'worker/enqueue',
      type,
      tenantId,
      error: message,
    });
    return;
  }

  // The provider becomes a fairness LANE on the source. Every knowledge event
  // used to be `knowledge`, which made the queue's round-robin useless here:
  // there was only ever one source to be fair between, so a big Confluence
  // space could enqueue thousands of pages and every Jira issue behind them
  // waited its turn. Dispatch resolves the lane back to `knowledge`.
  const provider = typeof payload.provider === 'string' ? payload.provider : null;
  const enqueued = await embeddingQueue.producer.enqueue({
    tenantId,
    source: provider ? `${KNOWLEDGE_SOURCE}:${provider}` : KNOWLEDGE_SOURCE,
    type,
    payload: encrypted,
    orderingKey,
  });
  if (!enqueued.ok) {
    if (options.strict) {
      throw new Error(`knowledge job ${type} not enqueued: ${enqueued.err.message ?? 'unknown'}`);
    }
    logger.error('knowledge job {type} not enqueued: {error}', {
      component: 'worker/enqueue',
      type,
      tenantId,
      error: enqueued.err.message ?? 'unknown',
    });
  }
}
