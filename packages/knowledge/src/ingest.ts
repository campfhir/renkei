/**
 * Single-chunk ingestion: embed and upsert one row keyed by its durable
 * SourceRef. Objects that may exceed one embedding-sized chunk go through
 * ingestObjectChunks (chunking.ts), which delegates here per chunk.
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { getDatabase } from '@renkei/db';
import { ok, err, wrapAsync } from '@campfhir/safe-functions/helpers';
import type { Result } from '@campfhir/safe-functions/types';
import { vectorLiteral } from './embeddings';
import type { EmbeddingProvider } from './embeddings';

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
): Promise<Result<void, 'EMBEDDING_FAILED' | 'DB_ERROR'>> {
  const embedded = await embedder.embed([chunk.content]);
  if (!embedded.ok) return embedded;
  return upsertChunkRow(tenantId, chunk, embedded.val[0] ?? []);
}

/** The upsert half of ingestChunk, for callers that already hold the vector. */
export async function upsertChunkRow(
  tenantId: string,
  chunk: KnowledgeChunkInput,
  embedding: readonly number[]
): Promise<Result<void, 'DB_ERROR'>> {
  const vector = vectorLiteral(embedding);

  const dbResult = getDatabase();
  if (!dbResult.ok) return err('DB_ERROR' as const);

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
          content: chunk.content,
          embedding: sql`${vector}::vector`,
          source_at: sourceAt,
        })
        .onConflict((oc) =>
          // source_at must be in the update set too: a re-ingest of an edited
          // page carries a newer document date, and omitting it here would
          // pin the row to whatever date the first ingest saw.
          oc.columns(['tenant_id', 'provider', 'ref_id']).doUpdateSet({
            metadata: JSON.stringify(chunk.metadata),
            content: chunk.content,
            embedding: sql`${vector}::vector`,
            source_at: sourceAt,
          })
        )
        .execute(),
    'DB_ERROR' as const
  );
  if (!result.ok) return result;
  return ok();
}
