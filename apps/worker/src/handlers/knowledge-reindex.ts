/**
 * `knowledge/reindex.batch` — one link of an admin-started reindex chain.
 *
 * The admin route (apps/web …/connectors/embeddings/reindex) creates a
 * `knowledge_reindex_runs` row and enqueues the first batch; each batch
 * does a bounded slice of the work (packages/knowledge/src/reindex.ts),
 * records progress AND THE CURSOR on the row, and enqueues the next link on
 * the same ordering key until the batch reports nothing left. Short links,
 * so a run of any size never outlives a delivery lease and any number of
 * embedding workers can share the chain.
 *
 * The stored cursor is what makes a stopped run resumable instead of a
 * do-over: the admin route's `action: 'resume'` re-enqueues one link
 * carrying the row's own cursor, so `embed` — the one kind where later rows
 * are not distinguishable from already-done ones by content, only by having
 * already been walked past — picks back up instead of recomputing every
 * chunk from the start. `action: 'pause'` sets the row's status away from
 * "running"; this handler re-checks that status right before enqueuing the
 * NEXT link (below), so a pause takes effect after at most the in-flight
 * link rather than the chain running to completion regardless.
 *
 * Failure policy departs from the ingest handlers on purpose: a failing
 * batch marks the RUN failed with the reason and completes the job rather
 * than throwing. A retry loop here would repeat the same provider call
 * against the same failing endpoint while the admin's status read
 * "running"; a failed run with its error visible, and a button that resumes
 * from its cursor once the cause is fixed, is the honest shape.
 *
 * A rate limit (429) is the one exception: unlike a broken endpoint or bad
 * config, it is expected to clear on its own. That case throws instead,
 * same as knowledge-ingest.ts, and lets the queue's own backoff (packages/
 * queue's retry policy) redeliver this one link — the run stays "running",
 * the cursor is untouched because nothing here was persisted, and the chain
 * picks back up once the provider does. If throttling outlasts the queue's
 * own retry budget and the link dead-letters, the run is left "running"
 * forever with nothing left to redeliver it — resume only accepts a
 * "paused" or "failed" row, so recovering a run stuck this way is
 * pause-then-resume: pausing a "running" row is allowed unconditionally
 * (there is no live link to race against once the dead-letter has already
 * happened), and resuming it from there re-arms the chain from the row's
 * own cursor exactly as it would for any other stopped run.
 */

import { sql } from 'kysely';
import { getDatabase } from '@renkei/db';
import { contentEncryptionKey } from '@renkei/crypto';
import {
  resolveEmbeddingProvider,
  resolveKeywordExtractor,
  reindexLexicalBatch,
  reembedBatch,
  extractKeywordsBatch,
  isReindexKind,
} from '@renkei/knowledge';
import type { BatchOutcome, ReindexKind } from '@renkei/knowledge';
import { enqueueKnowledgeEvent } from '../enqueue';
import type { EventHandler } from '../handlers';
import { logger } from '../logger';

const COMPONENT = 'knowledge/reindex';

/** Rows (or objects) per link, sized so a link stays well inside a lease. */
const BATCH_LIMIT: Record<ReindexKind, number> = { lexical: 200, embed: 128, keywords: 20 };
/** A skip list past this is a model that is failing, not a few odd objects. */
const MAX_SKIP = 500;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * A database failure, with the database's own words. The run row is what
 * the admin reads, so the reason has to reach it — "could not be updated"
 * alone sent an operator to the container logs, where nothing more was
 * said either.
 */
function storeFailure(message: string | undefined): string {
  return `the knowledge store could not be updated${message ? `: ${message}` : ''}`;
}

export function reindexOrderingKey(tenantId: string, runId: string): string {
  return `reindex/${tenantId}/${runId}`;
}

export interface ReindexHandlerDeps {
  enqueue?: typeof enqueueKnowledgeEvent;
}

export function createKnowledgeReindexBatchHandler(deps: ReindexHandlerDeps = {}): EventHandler {
  const enqueue = deps.enqueue ?? enqueueKnowledgeEvent;

  return async (event) => {
    const payload = isRecord(event.payload) ? event.payload : {};
    const runId = typeof payload.runId === 'string' ? payload.runId : '';
    const kind = payload.kind;
    if (!runId || !isReindexKind(kind)) {
      throw new Error('reindex batch payload is missing runId/kind');
    }
    const cursor = typeof payload.cursor === 'string' ? payload.cursor : null;
    const skip = new Set(
      Array.isArray(payload.skip)
        ? payload.skip.filter((entry): entry is string => typeof entry === 'string')
        : []
    );
    const tenantId = event.tenant_id;

    const dbResult = getDatabase();
    if (!dbResult.ok) throw new Error('database unavailable');
    const db = dbResult.val;

    const run = await db
      .selectFrom('knowledge_reindex_runs')
      .select(['status'])
      .where('id', '=', runId)
      .where('tenant_id', '=', tenantId)
      .executeTakeFirst();
    // A run the admin no longer has (deleted, or already ended) is done.
    if (!run || (run.status !== 'queued' && run.status !== 'running')) return 'skipped';

    const fail = async (message: string): Promise<void> => {
      await db
        .updateTable('knowledge_reindex_runs')
        .set({ status: 'failed', last_error: message, finished_at: sql`NOW()` })
        .where('id', '=', runId)
        .execute();
      logger.warn('reindex {kind} run {runId} failed: {error}', {
        component: COMPONENT,
        tenantId,
        kind,
        runId,
        error: message,
      });
    };

    if (run.status === 'queued') {
      await db
        .updateTable('knowledge_reindex_runs')
        .set({ status: 'running', started_at: sql`NOW()` })
        .where('id', '=', runId)
        .execute();
    }

    const keyResult = contentEncryptionKey();
    if (!keyResult.ok) {
      await fail(`content key unavailable: ${keyResult.err.message}`);
      return;
    }
    const key = keyResult.val;

    let outcome: BatchOutcome;
    if (kind === 'lexical') {
      const batch = await reindexLexicalBatch(tenantId, key, BATCH_LIMIT.lexical);
      if (!batch.ok) {
        await fail(storeFailure(batch.err.message));
        return;
      }
      outcome = batch.val;
    } else if (kind === 'embed') {
      const embedder = await resolveEmbeddingProvider(tenantId);
      if (!embedder) {
        await fail('no embedding provider is configured');
        return;
      }
      const batch = await reembedBatch(tenantId, embedder, key, cursor, BATCH_LIMIT.embed);
      if (!batch.ok) {
        if (batch.err.type === 'EMBEDDING_FAILED' && batch.err.cause === 429) {
          // Rate limited — nack for the queue's own retry/backoff rather
          // than failing the run; see the module doc comment.
          throw new Error(
            `embeddings endpoint rate limited (429): ${batch.err.message ?? 'unknown'}`
          );
        }
        await fail(
          batch.err.type === 'EMBEDDING_FAILED'
            ? `the embeddings endpoint failed: ${batch.err.message ?? 'unknown'}`
            : storeFailure(batch.err.message)
        );
        return;
      }
      outcome = batch.val;
    } else {
      const extractor = await resolveKeywordExtractor(tenantId);
      if (!extractor) {
        await fail('keyword enrichment is off, or the organization has no default model');
        return;
      }
      const batch = await extractKeywordsBatch(
        tenantId,
        extractor,
        key,
        BATCH_LIMIT.keywords,
        skip
      );
      if (!batch.ok) {
        await fail(storeFailure(batch.err.message));
        return;
      }
      outcome = batch.val;
      for (const entry of outcome.skip) skip.add(entry);
      // Every object in a batch failing, twice over, is the model failing.
      if (outcome.processed === 0 && outcome.failed > 0 && skip.size >= BATCH_LIMIT.keywords * 2) {
        await fail('the default model is failing on every item; check LLM models');
        return;
      }
      if (skip.size > MAX_SKIP) {
        await fail(`${skip.size} items could not be enriched; check LLM models and re-run`);
        return;
      }
    }

    await db
      .updateTable('knowledge_reindex_runs')
      .set({
        processed: sql`processed + ${outcome.processed}`,
        skipped: sql`skipped + ${outcome.skipped}`,
        failed: sql`failed + ${outcome.failed}`,
        cursor: outcome.cursor,
        ...(outcome.done ? { status: 'done', finished_at: sql`NOW()` } : {}),
      })
      .where('id', '=', runId)
      .execute();

    if (outcome.done) {
      logger.info('reindex {kind} run {runId} finished', {
        component: COMPONENT,
        tenantId,
        kind,
        runId,
      });
      return;
    }

    // A pause (POST .../reindex { action: 'pause' }) can land between this
    // link's own status check at the top of the handler and here — re-read
    // rather than trust the value from before this batch ran, so a pause
    // always takes effect after at most the in-flight link instead of the
    // chain running to completion regardless. What this link already did is
    // kept either way (the update above already committed it); pausing only
    // stops the NEXT link from being enqueued. Resuming re-arms the chain
    // from the row's own cursor.
    const current = await db
      .selectFrom('knowledge_reindex_runs')
      .select('status')
      .where('id', '=', runId)
      .executeTakeFirst();
    if (current?.status !== 'running') {
      logger.info('reindex {kind} run {runId} paused', {
        component: COMPONENT,
        tenantId,
        kind,
        runId,
      });
      return;
    }

    await enqueue(
      tenantId,
      'reindex.batch',
      {
        provider: 'reindex',
        runId,
        kind,
        ...(outcome.cursor ? { cursor: outcome.cursor } : {}),
        ...(skip.size > 0 ? { skip: [...skip] } : {}),
      },
      reindexOrderingKey(tenantId, runId),
      { strict: true }
    );
  };
}
