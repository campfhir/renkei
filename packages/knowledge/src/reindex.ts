/**
 * Reindex work in resumable batches — the shared core behind the CLI sweep
 * (scripts/reindex.ts) and the admin button (the embedding worker's
 * `knowledge/reindex.batch` job). Each function does ONE bounded batch and
 * reports whether more remains, so a run can be a chain of short queue
 * jobs that never outlives a delivery lease, and a script is just a loop.
 *
 *   lexical   Backfill `search_text` (migration 079) for rows that have
 *             none: decrypt the chunk, rebuild the weighted tsvector from
 *             its title, keywords and text. No provider calls; touches only
 *             NULL rows, so it is self-consuming and needs no cursor.
 *
 *   embed     Recompute the vector of every MULTI-chunk row with its
 *             contextual header (context.ts) prepended, the way ingest now
 *             embeds them. Calls the embeddings endpoint. Single-chunk rows
 *             are embedded bare by ingest too and are skipped. Cursor: the
 *             last row id.
 *
 *   keywords  Extract search keywords (migration 080, keywords.ts) for every
 *             OBJECT whose rows have none, one model call per object, and
 *             rebuild each row's tsvector to carry them. Self-consuming like
 *             lexical, except that an object the model failed on is left
 *             NULL for a later retry and must be skipped for the rest of
 *             the run — `skip` carries those between batches.
 */

import { getDataStore } from '@renkei/db';
import { decryptContent } from '@renkei/crypto';
import { ok, wrapAsync } from '@campfhir/safe-functions/helpers';
import type { Result } from '@campfhir/safe-functions/types';
import type { EmbeddingProvider } from './embeddings';
import { searchTextParts, LEXICAL_CONFIG } from './ingest';
import { titleOf, chunkContext, embeddingInput } from './context';
import type { KeywordExtractor } from './keywords';
import { isRecord } from '@renkei/guards';

export type ReindexKind = 'lexical' | 'embed' | 'keywords';
export const REINDEX_KINDS: readonly ReindexKind[] = ['lexical', 'embed', 'keywords'];

export function isReindexKind(value: unknown): value is ReindexKind {
  return REINDEX_KINDS.some((kind) => kind === value);
}

/** Pieces per embeddings request — the same bound ingest uses. */
const EMBED_BATCH = 64;

export interface BatchOutcome {
  /** Rows (lexical, embed) or objects (keywords) this batch finished. */
  processed: number;
  /** Rows given an empty entry because they could not be read. */
  skipped: number;
  /** Rows or objects the provider failed on; left for a re-run. */
  failed: number;
  /** Nothing left after this batch. */
  done: boolean;
  /** Where the next batch continues (embed only). */
  cursor: string | null;
  /** Objects to skip for the rest of this run (keywords only). */
  skip: string[];
}

function metadataOf(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function keywordsOf(value: unknown): string[] | null {
  return Array.isArray(value)
    ? value.filter((keyword): keyword is string => typeof keyword === 'string')
    : null;
}

export async function reindexLexicalBatch(
  key: Buffer,
  limit: number
): Promise<Result<BatchOutcome, 'DB_ERROR'>> {
  return wrapAsync(async () => {
    const chunks = getDataStore().knowledgeChunks;
    const rows = await chunks.listUnsearchable(limit);

    let skipped = 0;
    for (const row of rows) {
      const opened = decryptContent(row.content, key);
      if (!opened.ok) {
        // Wrong key or a pre-encryption row: give it an empty entry so the
        // sweep terminates rather than re-selecting it forever.
        skipped += 1;
        await chunks.setSearchText(row.id, null);
        continue;
      }
      await chunks.setSearchText(
        row.id,
        searchTextParts(titleOf(metadataOf(row.metadata)), keywordsOf(row.keywords), opened.val)
      );
    }
    return {
      processed: rows.length - skipped,
      skipped,
      failed: 0,
      done: rows.length < limit,
      cursor: null,
      skip: [],
    };
  }, 'DB_ERROR' as const);
}

export async function reembedBatch(
  embedder: EmbeddingProvider,
  key: Buffer,
  cursor: string | null,
  limit: number
): Promise<Result<BatchOutcome, 'DB_ERROR' | 'EMBEDDING_FAILED'>> {
  const chunks = getDataStore().knowledgeChunks;

  // Only multi-chunk rows carry a header; ingest stamps `chunkCount` on
  // exactly those. A null cursor (the first batch) means no id filter.
  const rowsResult = await wrapAsync(
    () => chunks.listMultiChunk(cursor || null, limit),
    'DB_ERROR' as const
  );
  if (!rowsResult.ok) return rowsResult;
  const rows = rowsResult.val;

  let skipped = 0;
  const inputs: { id: string; text: string }[] = [];
  for (const row of rows) {
    const opened = decryptContent(row.content, key);
    if (!opened.ok) {
      skipped += 1;
      continue;
    }
    inputs.push({
      id: row.id,
      text: embeddingInput(chunkContext(metadataOf(row.metadata)), opened.val),
    });
  }

  let processed = 0;
  for (let at = 0; at < inputs.length; at += EMBED_BATCH) {
    const slice = inputs.slice(at, at + EMBED_BATCH);
    const embedded = await embedder.embed(
      slice.map((input) => input.text),
      'passage'
    );
    if (!embedded.ok) return embedded;
    for (const [index, input] of slice.entries()) {
      const vector = embedded.val[index];
      if (!vector) continue;
      const updated = await wrapAsync(
        () => chunks.setEmbedding(input.id, vector),
        'DB_ERROR' as const
      );
      if (!updated.ok) return updated;
      processed += 1;
    }
  }

  return ok({
    processed,
    skipped,
    failed: 0,
    done: rows.length < limit,
    cursor: rows[rows.length - 1]?.id ?? cursor,
    skip: [],
  });
}

export async function extractKeywordsBatch(
  extractor: KeywordExtractor,
  key: Buffer,
  limit: number,
  skip: ReadonlySet<string>
): Promise<Result<BatchOutcome, 'DB_ERROR'>> {
  return wrapAsync(async () => {
    const chunks = getDataStore().knowledgeChunks;
    // Objects, not rows: one model call covers every chunk of an object
    // (its ref before the `#0001` suffix). Over-select by the skip list so
    // skipped objects cannot crowd out the ones still to do.
    const pending = await chunks.listObjectsWithoutKeywords(limit + skip.size);
    const todo = pending
      .filter((row) => !skip.has(`${row.provider} ${row.objectRef}`))
      .slice(0, limit);

    let processed = 0;
    let skipped = 0;
    const failedKeys: string[] = [];
    for (const { provider, objectRef: ref } of todo) {
      const rows = await chunks.objectChunks(provider, ref);

      const pieces: string[] = [];
      let undecryptable = false;
      for (const row of rows) {
        const opened = decryptContent(row.content, key);
        if (!opened.ok) {
          undecryptable = true;
          break;
        }
        pieces.push(opened.val);
      }
      const title = titleOf(metadataOf(rows[0]?.metadata));

      // An object we cannot read gets an empty list so the sweep moves on;
      // a model failure leaves NULL so a re-run retries it.
      let keywords: string[] | null = null;
      if (undecryptable) {
        keywords = [];
        skipped += 1;
      } else {
        const extracted = await extractor.extract({ title, content: pieces.join('\n\n') });
        if (extracted.ok) keywords = extracted.val;
        else failedKeys.push(`${provider} ${ref}`);
      }
      if (keywords === null) continue;

      for (const [index, row] of rows.entries()) {
        await chunks.rewriteChunk(row.id, {
          keywords,
          lexical: { config: LEXICAL_CONFIG, title, keywords, text: pieces[index] ?? '' },
        });
      }
      if (!undecryptable) processed += 1;
    }

    return {
      processed,
      skipped,
      failed: failedKeys.length,
      done: todo.length < limit,
      cursor: null,
      skip: failedKeys,
    };
  }, 'DB_ERROR' as const);
}
