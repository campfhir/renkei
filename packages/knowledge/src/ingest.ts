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
}

export async function ingestChunk(
  tenantId: string,
  embedder: EmbeddingProvider,
  chunk: KnowledgeChunkInput
): Promise<Result<void, 'EMBEDDING_FAILED' | 'DB_ERROR'>> {
  const embedded = await embedder.embed([chunk.content]);
  if (!embedded.ok) return embedded;
  const vector = vectorLiteral(embedded.val[0] ?? []);

  const dbResult = getDatabase();
  if (!dbResult.ok) return err('DB_ERROR' as const);

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
        })
        .onConflict((oc) =>
          oc.columns(['tenant_id', 'provider', 'ref_id']).doUpdateSet({
            metadata: JSON.stringify(chunk.metadata),
            content: chunk.content,
            embedding: sql`${vector}::vector`,
          })
        )
        .execute(),
    'DB_ERROR' as const
  );
  if (!result.ok) return result;
  return ok();
}
