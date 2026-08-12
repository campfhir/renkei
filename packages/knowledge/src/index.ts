/**
 * @renkei/knowledge — the minimal knowledge layer (RENKEI.md Phase 1).
 *
 * Ingestion embeds a chunk and upserts it with its durable SourceRef;
 * retrieval embeds the query, PROPOSES candidates by cosine distance, and
 * passes every candidate through the live ACL gate (@renkei/gates,
 * Decisions #14/#18) before anything is returned. The index is never
 * authorization; the gate is.
 */

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

export {
  chunkText,
  chunkRefId,
  deleteObjectChunks,
  ingestObjectChunks,
  type ChunkTextOptions,
} from './chunking';

export { ingestChunk, type KnowledgeChunkInput } from './ingest';

export interface KnowledgeHit {
  provider: string;
  refId: string;
  content: string;
  metadata: Record<string, unknown>;
  /** Cosine distance — smaller is closer. */
  distance: number;
  /** The source document's own date, when the connector recorded one. */
  sourceAt: string | null;
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
  /**
   * Narrow to these providers ('microsoft', 'zoom', …). Empty/omitted
   * searches every provider.
   */
  providers?: readonly string[];
  /**
   * Narrow to these `metadata.kind` values ('msg', 'evt', 'transcript'…).
   * The vocabulary is per-connector, so this is normally paired with
   * `providers` rather than used alone.
   */
  kinds?: readonly string[];
  /** Only documents dated on/after this ISO-8601 instant. Undated rows are excluded. */
  after?: string;
  /** Only documents dated before this ISO-8601 instant. Undated rows are excluded. */
  before?: string;
}

interface CandidateRow {
  provider: string;
  ref_id: string;
  content: string;
  metadata: unknown;
  distance: number;
  source_at: Date | string | null;
}

/** Drops empty/blank entries so an all-blank filter reads as "no filter", not "match nothing". */
function cleanList(values: readonly string[] | undefined): string[] {
  return (values ?? []).map((value) => value.trim()).filter(Boolean);
}

/** A parseable date, or null — a malformed filter is ignored rather than matching nothing. */
function boundary(value: string | undefined): Date | null {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/** The driver may hand back a Date or a string depending on the column type; normalize to ISO. */
function sourceAtIso(value: Date | string | null): string | null {
  if (value === null) return null;
  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

/** What narrows a candidate set, shared by semantic search and recency browse. */
interface CandidateFilters {
  providers?: readonly string[];
  kinds?: readonly string[];
  after?: string;
  before?: string;
}

/**
 * The WHERE fragments for the filters, each a no-op `TRUE` when absent so
 * the unfiltered plan stays identical. Built once and shared so browse and
 * search can never disagree about what a filter means.
 */
function filterFragments(filters: CandidateFilters) {
  const providers = cleanList(filters.providers);
  const kinds = cleanList(filters.kinds);
  const after = boundary(filters.after);
  const before = boundary(filters.before);
  return {
    provider: providers.length > 0 ? sql`provider = ANY(${providers})` : sql`TRUE`,
    kind: kinds.length > 0 ? sql`metadata ->> 'kind' = ANY(${kinds})` : sql`TRUE`,
    // A dated filter excludes undated rows rather than treating NULL as epoch.
    after: after ? sql`source_at IS NOT NULL AND source_at >= ${after}` : sql`TRUE`,
    before: before ? sql`source_at IS NOT NULL AND source_at < ${before}` : sql`TRUE`,
  };
}

function toHit(row: CandidateRow): KnowledgeHit {
  return {
    provider: row.provider,
    refId: row.ref_id,
    content: row.content,
    metadata:
      typeof row.metadata === 'object' && row.metadata !== null && !Array.isArray(row.metadata)
        ? { ...row.metadata }
        : {},
    distance: Number(row.distance),
    sourceAt: sourceAtIso(row.source_at),
  };
}

export interface RecentOptions extends CandidateFilters {
  tenantId: string;
  /** Whose access the gate verifies. Nothing is disclosed without it. */
  userEmail: string;
  k: number;
  verifiers: ReadonlyMap<string, AccessVerifier>;
  budgetMs?: number;
}

/**
 * The most recently DATED indexed items, newest first — what to show when
 * there is no query yet, so a knowledge surface reveals what it actually
 * holds instead of an empty box.
 *
 * Deliberately not `searchKnowledge` with a blank query: an embedding of ""
 * is meaningless, and ordering by its distance would return an arbitrary
 * slice while looking authoritative. No embedder is needed or accepted
 * here, so this also works before an org configures one.
 *
 * Same ACL gate as search — the index only proposes, and rows the caller
 * cannot open at the source are withheld and counted.
 */
export async function listRecentKnowledge(
  options: RecentOptions
): Promise<Result<KnowledgeSearchResult, 'DB_ERROR'>> {
  const dbResult = getDatabase();
  if (!dbResult.ok) return err('DB_ERROR' as const);

  const filters = filterFragments(options);
  const overfetch = Math.max(options.k * 2, options.k + 4);
  const rowsResult = await wrapAsync(
    () =>
      sql<CandidateRow>`
        SELECT provider, ref_id, content, metadata, source_at, 0 AS distance
        FROM knowledge_chunks
        WHERE tenant_id = ${options.tenantId}
          AND source_at IS NOT NULL
          AND ${filters.provider}
          AND ${filters.kind}
          AND ${filters.after}
          AND ${filters.before}
        ORDER BY source_at DESC
        LIMIT ${overfetch}
      `.execute(dbResult.val),
    'DB_ERROR' as const
  );
  if (!rowsResult.ok) return rowsResult;

  const outcome = await verifyCandidates(
    options.verifiers,
    options.userEmail,
    rowsResult.val.rows,
    (row) => ({ provider: row.provider, refId: row.ref_id }),
    { budgetMs: options.budgetMs ?? 3_000 }
  );

  return ok({
    hits: outcome.allowed.slice(0, options.k).map(toHit),
    elided: outcome.elided,
  });
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

  // Every narrowing predicate belongs HERE, not in a post-fetch filter: the
  // query returns only `overfetch` rows ordered by distance, so filtering
  // afterwards would discard most of an already-small candidate set and
  // starve the result list.
  const filters = filterFragments(options);

  const rowsResult = await wrapAsync(
    () =>
      sql<CandidateRow>`
        SELECT provider, ref_id, content, metadata, source_at,
               (embedding <=> ${vector}::vector) AS distance
        FROM knowledge_chunks
        WHERE tenant_id = ${options.tenantId}
          AND ${filters.provider}
          AND ${filters.kind}
          AND ${filters.after}
          AND ${filters.before}
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

  return ok({ hits: outcome.allowed.slice(0, options.k).map(toHit), elided: outcome.elided });
}
