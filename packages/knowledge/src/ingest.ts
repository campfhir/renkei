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
  /**
   * The object's LLM-extracted search terms (keywords.ts), shared by every
   * chunk of it. Omitted/null stores NULL ("not extracted"), which the
   * reindex sweep later fills; an empty array stores as empty and is left
   * alone ("extracted, nothing worth indexing").
   */
  keywords?: readonly string[] | null;
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

/**
 * Text as Postgres will accept it in a `text` parameter: NUL bytes out.
 *
 * Extracted document text (PDF, docx) and the odd mail body carry U+0000,
 * and Postgres refuses it in any text value ("invalid byte sequence for
 * encoding UTF8: 0x00"). The stored content never met that rule because
 * it is ciphertext; the lexical index is the first place the plaintext
 * reaches the database, and a single such chunk failed its whole ingest
 * — and every reindex batch that included it — with that error.
 */
export function postgresText(value: string): string {
  return value.includes('\u0000') ? value.split('\u0000').join('') : value;
}

/** `to_tsvector(config, text)` — the config rides as a bound parameter cast to regconfig. */
function tsvector(text: string): RawBuilder<string> {
  return sql<string>`to_tsvector(${LEXICAL_CONFIG}::regconfig, ${postgresText(text)})`;
}

/**
 * The lexical index entry for one chunk, three weights deep: the
 * document's title at A, its extracted keywords at B, the chunk text at
 * C. So a query naming a page ranks that page's chunks first, a query
 * naming what a page is ABOUT ranks it next, and a chunk that merely
 * mentions the words comes last. Built from PLAINTEXT — the stored content
 * is ciphertext, so this is the one place a chunk's words reach Postgres
 * in the clear, and the tsvector that results is a bag of stemmed lexemes
 * rather than the text itself. See migration 079 for the at-rest
 * trade-off that accepts.
 */
export function searchTextFragment(
  title: string,
  keywords: readonly string[] | null | undefined,
  content: string
): RawBuilder<string> {
  const phrases = (keywords ?? []).join(', ');
  return sql<string>`setweight(${tsvector(title)}, 'A') || setweight(${tsvector(phrases)}, 'B') || setweight(${tsvector(content)}, 'C')`;
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
  const keywords = chunk.keywords ? chunk.keywords.map(postgresText) : null;
  const searchText = searchTextFragment(titleOf(chunk.metadata), keywords, chunk.content);

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
          keywords,
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
            keywords,
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
