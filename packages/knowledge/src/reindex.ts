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

import { sql } from 'kysely';
import { getDatabase } from '@renkei/db';
import { decryptContent } from '@renkei/crypto';
import { ok, err, wrapAsync } from '@campfhir/safe-functions/helpers';
import type { Result } from '@campfhir/safe-functions/types';
import { vectorLiteral } from './embeddings';
import type { EmbeddingProvider } from './embeddings';
import { searchTextFragment } from './ingest';
import { titleOf, chunkContext, embeddingInput } from './context';
import type { KeywordExtractor } from './keywords';

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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
  tenantId: string | null,
  key: Buffer,
  limit: number
): Promise<Result<BatchOutcome, 'DB_ERROR'>> {
  const dbResult = getDatabase();
  if (!dbResult.ok) return err('DB_ERROR' as const);
  const db = dbResult.val;

  return wrapAsync(async () => {
    let query = db
      .selectFrom('knowledge_chunks')
      .select(['id', 'content', 'metadata', 'keywords'])
      .where('search_text', 'is', null)
      .orderBy('id')
      .limit(limit);
    if (tenantId) query = query.where('tenant_id', '=', tenantId);
    const rows = await query.execute();

    let skipped = 0;
    for (const row of rows) {
      const opened = decryptContent(row.content, key);
      if (!opened.ok) {
        // Wrong key or a pre-encryption row: give it an empty entry so the
        // sweep terminates rather than re-selecting it forever.
        skipped += 1;
        await db
          .updateTable('knowledge_chunks')
          .set({ search_text: sql<string>`to_tsvector('')` })
          .where('id', '=', row.id)
          .execute();
        continue;
      }
      await db
        .updateTable('knowledge_chunks')
        .set({
          search_text: searchTextFragment(
            titleOf(metadataOf(row.metadata)),
            keywordsOf(row.keywords),
            opened.val
          ),
        })
        .where('id', '=', row.id)
        .execute();
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
  tenantId: string,
  embedder: EmbeddingProvider,
  key: Buffer,
  cursor: string | null,
  limit: number
): Promise<Result<BatchOutcome, 'DB_ERROR' | 'EMBEDDING_FAILED'>> {
  const dbResult = getDatabase();
  if (!dbResult.ok) return err('DB_ERROR' as const);
  const db = dbResult.val;

  const rowsResult = await wrapAsync(() => {
    let query = db
      .selectFrom('knowledge_chunks')
      .select(['id', 'content', 'metadata'])
      .where('tenant_id', '=', tenantId)
      // Only multi-chunk rows carry a header; ingest stamps `chunkCount`
      // on exactly those.
      .where(sql<boolean>`(metadata ->> 'chunkCount')::int > 1`);
    if (cursor) query = query.where('id', '>', cursor);
    return query.orderBy('id').limit(limit).execute();
  }, 'DB_ERROR' as const);
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
        () =>
          db
            .updateTable('knowledge_chunks')
            .set({ embedding: sql`${vectorLiteral(vector)}::vector` })
            .where('id', '=', input.id)
            .execute(),
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

/** The logical object a chunk row belongs to: its ref before the `#0001` suffix. */
const objectRef = sql<string>`regexp_replace(ref_id, '#[0-9]{4}$', '')`;

export async function extractKeywordsBatch(
  tenantId: string,
  extractor: KeywordExtractor,
  key: Buffer,
  limit: number,
  skip: ReadonlySet<string>
): Promise<Result<BatchOutcome, 'DB_ERROR'>> {
  const dbResult = getDatabase();
  if (!dbResult.ok) return err('DB_ERROR' as const);
  const db = dbResult.val;

  return wrapAsync(async () => {
    // Objects, not rows: one model call covers every chunk of an object.
    // Over-select by the skip list so skipped objects cannot crowd out
    // the ones still to do.
    const pending = await db
      .selectFrom('knowledge_chunks')
      .select(['provider', objectRef.as('object_ref')])
      .where('tenant_id', '=', tenantId)
      .where('keywords', 'is', null)
      .groupBy(['provider', objectRef])
      .orderBy('provider')
      .orderBy(objectRef)
      .limit(limit + skip.size)
      .execute();
    const todo = pending
      .filter((row) => !skip.has(`${row.provider} ${row.object_ref}`))
      .slice(0, limit);

    let processed = 0;
    let skipped = 0;
    const failedKeys: string[] = [];
    for (const { provider, object_ref: ref } of todo) {
      const rows = await db
        .selectFrom('knowledge_chunks')
        .select(['id', 'ref_id', 'content', 'metadata'])
        .where('tenant_id', '=', tenantId)
        .where('provider', '=', provider)
        .where((eb) => eb.or([eb('ref_id', '=', ref), eb('ref_id', 'like', `${ref}#%`)]))
        .orderBy('ref_id')
        .execute();

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
        await db
          .updateTable('knowledge_chunks')
          .set({
            keywords,
            search_text: searchTextFragment(title, keywords, pieces[index] ?? ''),
          })
          .where('id', '=', row.id)
          .execute();
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
