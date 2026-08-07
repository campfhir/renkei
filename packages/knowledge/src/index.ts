/**
 * @renkei/knowledge — the minimal knowledge layer (RENKEI.md Phase 1).
 *
 * Ingestion embeds a chunk and upserts it with its durable SourceRef;
 * retrieval embeds the query, PROPOSES candidates by cosine distance, and
 * passes every candidate through the live ACL gate (@renkei/gates,
 * Decisions #14/#18) before anything is returned. The index is never
 * authorization; the gate is.
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { getDatabase } from '@renkei/db';
import { verifyCandidates } from '@renkei/gates';
import type { AccessVerifier, SourceRef } from '@renkei/gates';
import { ok, err, wrapAsync } from '@campfhir/safe-functions/helpers';
import type { Result } from '@campfhir/safe-functions/types';
import { vectorLiteral } from './embeddings';
import type { EmbeddingProvider } from './embeddings';

export {
  EMBEDDINGS_CONNECTOR,
  OpenAiCompatibleEmbeddings,
  resolveEmbeddingProvider,
  vectorLiteral,
  type EmbeddingProvider,
} from './embeddings';

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

export interface KnowledgeHit {
  provider: string;
  refId: string;
  content: string;
  metadata: Record<string, unknown>;
  /** Cosine distance — smaller is closer. */
  distance: number;
}

export interface KnowledgeSearchResult {
  hits: KnowledgeHit[];
  /** Candidates withheld by the gate — reported, never silently dropped. */
  elided: number;
}

export interface SearchOptions {
  tenantId: string;
  /** Whose access the gate verifies. Nothing is disclosed without it. */
  userEmail: string;
  query: string;
  k: number;
  embedder: EmbeddingProvider;
  verifiers: ReadonlyMap<string, AccessVerifier>;
  /** Verification time budget; expired = denied (gate semantics). */
  budgetMs?: number;
  /** Refs to leave out (e.g. the object that triggered the search). */
  excludeRef?: SourceRef;
}

interface CandidateRow {
  provider: string;
  ref_id: string;
  content: string;
  metadata: unknown;
  distance: number;
}

export async function searchKnowledge(
  options: SearchOptions
): Promise<Result<KnowledgeSearchResult, 'EMBEDDING_FAILED' | 'DB_ERROR'>> {
  const embedded = await options.embedder.embed([options.query]);
  if (!embedded.ok) return embedded;
  const vector = vectorLiteral(embedded.val[0] ?? []);

  const dbResult = getDatabase();
  if (!dbResult.ok) return err('DB_ERROR' as const);

  // Overfetch beyond k: the gate will deny some candidates, and returning
  // fewer results is the correct degradation — the index only proposes.
  const overfetch = Math.max(options.k * 2, options.k + 4);
  const rowsResult = await wrapAsync(
    () =>
      sql<CandidateRow>`
        SELECT provider, ref_id, content, metadata,
               (embedding <=> ${vector}::vector) AS distance
        FROM knowledge_chunks
        WHERE tenant_id = ${options.tenantId}
        ORDER BY distance
        LIMIT ${overfetch}
      `.execute(dbResult.val),
    'DB_ERROR' as const
  );
  if (!rowsResult.ok) return rowsResult;

  const candidates = rowsResult.val.rows.filter(
    (row) =>
      !options.excludeRef ||
      row.provider !== options.excludeRef.provider ||
      row.ref_id !== options.excludeRef.refId
  );

  const outcome = await verifyCandidates(
    options.verifiers,
    options.userEmail,
    candidates,
    (row) => ({ provider: row.provider, refId: row.ref_id }),
    { budgetMs: options.budgetMs ?? 3_000 }
  );

  const hits = outcome.allowed.slice(0, options.k).map((row) => ({
    provider: row.provider,
    refId: row.ref_id,
    content: row.content,
    metadata:
      typeof row.metadata === 'object' && row.metadata !== null && !Array.isArray(row.metadata)
        ? { ...row.metadata }
        : {},
    distance: Number(row.distance),
  }));

  return ok({ hits, elided: outcome.elided });
}
