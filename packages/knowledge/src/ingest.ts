/**
 * Single-chunk ingestion: embed and upsert one row keyed by its durable
 * SourceRef. Objects that may exceed one embedding-sized chunk go through
 * ingestObjectChunks (chunking.ts), which delegates here per chunk.
 */

import { randomUUID } from 'node:crypto';
import { sql, type RawBuilder } from 'kysely';
import { getDatabase } from '@renkei/db';
import { contentEncryptionKey, encryptContent } from '@renkei/crypto';
import { ok, err, wrapAsync } from '@campfhir/safe-functions/helpers';
import type { Result } from '@campfhir/safe-functions/types';
import { vectorLiteral } from './embeddings';
import type { EmbeddingProvider } from './embeddings';
import { titleOf } from './context';

export interface KnowledgeChunkInput {
  /** SourceRef the retrieval gate verifies — the connector defines refId's shape. */
  provider: string;
  refId: string;
  content: string;
  /** Candidate-narrowing/display detail; never authorization. */
  metadata: Record<string, unknown>;
  /**
   * The SOURCE document's own timestamp (mail received, page modified…),
   * ISO-8601 — what date filters mean by "when". Distinct from the row's
   * `created_at`, which is ingest time and is deliberately not refreshed on
   * re-ingest. Omit when the connector has no meaningful document date;
   * NULL reads as "undated" and a date filter excludes it.
   */
  sourceAt?: string | null;
}

/**
 * The text-search configuration the lexical index is built and queried
 * with. One constant on purpose: a tsvector built under one config does
 * not match a tsquery parsed under another, so the two sides must never
 * be able to disagree. 'english' stems and drops stopwords, which is right
 * for the prose most orgs index, and still tokenises identifiers
 * ("ENG-787" → eng-787, eng, 787) — the exact tokens dense retrieval is
 * worst at.
 */
export const LEXICAL_CONFIG = 'english';

/** `to_tsvector(config, text)` — the config rides as a bound parameter cast to regconfig. */
function tsvector(text: string): RawBuilder<string> {
  return sql<string>`to_tsvector(${LEXICAL_CONFIG}::regconfig, ${text})`;
}

/**
 * The lexical index entry for one chunk: its document's title at weight A,
 * the chunk text at weight B, so a query naming a page ranks that page's
 * chunks above chunks that merely mention it. Built from PLAINTEXT — the
 * stored content is ciphertext, so this is the one place a chunk's words
 * reach Postgres in the clear, and the tsvector that results is a bag of
 * stemmed lexemes rather than the text itself. See migration 079 for the
 * at-rest trade-off that accepts.
 */
export function searchTextFragment(title: string, content: string): RawBuilder<string> {
  return sql<string>`setweight(${tsvector(title)}, 'A') || setweight(${tsvector(content)}, 'B')`;
}

/** An unparseable date is stored as NULL (undated) rather than throwing mid-ingest. */
function sourceAtValue(sourceAt: string | null | undefined): Date | null {
  if (!sourceAt) return null;
  const parsed = new Date(sourceAt);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export async function ingestChunk(
  tenantId: string,
  embedder: EmbeddingProvider,
  chunk: KnowledgeChunkInput
): Promise<Result<void, 'EMBEDDING_FAILED' | 'DB_ERROR' | 'ENCRYPTION_FAILED'>> {
  const embedded = await embedder.embed([chunk.content], 'passage');
  if (!embedded.ok) return embedded;
  return upsertChunkRow(tenantId, chunk, embedded.val[0] ?? []);
}

/** The upsert half of ingestChunk, for callers that already hold the vector. */
export async function upsertChunkRow(
  tenantId: string,
  chunk: KnowledgeChunkInput,
  embedding: readonly number[]
): Promise<Result<void, 'DB_ERROR' | 'ENCRYPTION_FAILED'>> {
  const vector = vectorLiteral(embedding);

  const dbResult = getDatabase();
  if (!dbResult.ok) return err('DB_ERROR' as const);

  // Content is CIPHERTEXT at rest; the embedding vector stays as computed
  // from the plaintext (that is the whole point of having it), and
  // provider/ref_id/metadata stay plaintext because the ACL gate, the
  // owner-scope prefix filter and the search filters all match on them.
  const keyResult = contentEncryptionKey();
  if (!keyResult.ok) {
    return err('ENCRYPTION_FAILED' as const, { message: keyResult.err.message });
  }
  const storedContent = encryptContent(chunk.content, keyResult.val);
  const searchText = searchTextFragment(titleOf(chunk.metadata), chunk.content);

  const sourceAt = sourceAtValue(chunk.sourceAt);
  const result = await wrapAsync(
    () =>
      dbResult.val
        .insertInto('knowledge_chunks')
        .values({
          id: randomUUID(),
          tenant_id: tenantId,
          provider: chunk.provider,
          ref_id: chunk.refId,
          metadata: JSON.stringify(chunk.metadata),
          content: storedContent,
          embedding: sql`${vector}::vector`,
          search_text: searchText,
          source_at: sourceAt,
        })
        .onConflict((oc) =>
          // source_at must be in the update set too: a re-ingest of an edited
          // page carries a newer document date, and omitting it here would
          // pin the row to whatever date the first ingest saw.
          oc.columns(['tenant_id', 'provider', 'ref_id']).doUpdateSet({
            metadata: JSON.stringify(chunk.metadata),
            content: storedContent,
            embedding: sql`${vector}::vector`,
            search_text: searchText,
            source_at: sourceAt,
          })
        )
        .execute(),
    'DB_ERROR' as const
  );
  if (!result.ok) return result;
  return ok();
}
