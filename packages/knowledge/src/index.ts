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
import { contentEncryptionKey, revealContent } from '@renkei/crypto';
import { verifyCandidates } from '@renkei/gates';
import type { AccessVerifier, SourceRef } from '@renkei/gates';
import { ok, err, wrapAsync } from '@campfhir/safe-functions/helpers';
import type { Result } from '@campfhir/safe-functions/types';
import { vectorLiteral } from './embeddings';
import type { EmbeddingProvider } from './embeddings';
import { escapeLike } from './chunking';

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
  deleteChunksByMetadata,
  readObjectMetadataBatch,
  deleteStaleScopeChunks,
  ingestObjectChunks,
  type ChunkTextOptions,
} from './chunking';

export { ingestChunk, type KnowledgeChunkInput } from './ingest';

export {
  NOTE_KNOWLEDGE_PROVIDER,
  AUTHORED_PROVIDERS,
  NOTE_CHUNKING,
  noteRefId,
  ownerOfNoteRefId,
  createNoteAccessVerifier,
} from './note';

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
  /**
   * Of those, how many went unanswered before the gate's budget expired
   * rather than being refused. Callers should say so: "withheld" and "we
   * could not check in time" look identical in a result list, and only one of
   * them means something is wrong.
   */
  unverified: number;
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
   * Narrow to these sources. Empty/omitted searches everything.
   *
   * A source is a provider optionally pinned to one `metadata.kind`, and
   * the list is OR-ed. That shape is load-bearing: separate provider and
   * kind lists would AND, so asking for {microsoft,msg} + {jira} would
   * either drop Jira (no chunk has kind 'msg') or, if the kind were
   * dropped to save it, quietly widen microsoft to calendar and tasks too.
   */
  sources?: readonly SourceFilter[];
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

/** One selectable source: a provider, optionally pinned to a single kind. */
export interface SourceFilter {
  provider: string;
  /** A `metadata.kind` value; omitted means every kind of that provider. */
  kind?: string;
}

/** What narrows a candidate set, shared by semantic search and recency browse. */
interface CandidateFilters {
  sources?: readonly SourceFilter[];
  after?: string;
  before?: string;
}

/**
 * The WHERE fragments for the filters, each a no-op `TRUE` when absent so
 * the unfiltered plan stays identical. Built once and shared so browse and
 * search can never disagree about what a filter means.
 */
function filterFragments(filters: CandidateFilters) {
  const sources = (filters.sources ?? []).filter((source) => source.provider.trim());
  const after = boundary(filters.after);
  const before = boundary(filters.before);
  // Each source contributes one AND-ed pair; the pairs are OR-ed together,
  // so a mixed selection means what it says rather than intersecting.
  const clauses = sources.map((source) =>
    source.kind
      ? sql`(provider = ${source.provider.trim()} AND metadata ->> 'kind' = ${source.kind})`
      : sql`(provider = ${source.provider.trim()})`
  );
  return {
    source: clauses.length > 0 ? sql`(${sql.join(clauses, sql` OR `)})` : sql`TRUE`,
    // A dated filter excludes undated rows rather than treating NULL as epoch.
    after: after ? sql`source_at IS NOT NULL AND source_at >= ${after}` : sql`TRUE`,
    before: before ? sql`source_at IS NOT NULL AND source_at < ${before}` : sql`TRUE`,
  };
}

/**
 * The proposal-side half of ownerScoped verifiers (see AccessVerifier):
 * providers whose whole ACL is the ref's owner prefix admit only the
 * requester's own rows into the candidate set. Foreign-owned rows would be
 * withheld by the gate anyway, but fetching them still counts them — and a
 * withheld tally of a coworker's mailbox is itself a disclosure, besides
 * eating overfetch slots that owned rows could have filled.
 *
 * The predicate mirrors the verifiers' parse exactly: owner is everything
 * before the first `/`, compared lowercased. Providers without the flag —
 * including providers with no verifier at all — pass through untouched, so
 * live-verified content and deployment bugs are still counted honestly.
 */
function ownerScopeFragment(verifiers: ReadonlyMap<string, AccessVerifier>, userEmail: string) {
  const scoped = [...verifiers.values()]
    .filter((verifier) => verifier.ownerScoped)
    .map((verifier) => sql`${verifier.provider}`);
  if (scoped.length === 0) return sql`TRUE`;
  const ownPrefix = `${escapeLike(userEmail.trim().toLowerCase())}/%`;
  return sql`(provider NOT IN (${sql.join(scoped, sql`, `)}) OR ref_id LIKE ${ownPrefix})`;
}

/** The content key once per query, null when unconfigured (legacy rows still read). */
function contentKeyOrNull(): Buffer | null {
  const keyResult = contentEncryptionKey();
  return keyResult.ok ? keyResult.val : null;
}

function toHit(row: CandidateRow, contentKey: Buffer | null): KnowledgeHit {
  return {
    provider: row.provider,
    refId: row.ref_id,
    // Stored ciphertext (or a legacy plaintext row) → plaintext for the
    // caller; the row was already ACL-verified before reaching here.
    content: revealContent(row.content, contentKey),
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

/** The source a row belongs to, for per-source quotas. */
function sourceKeyOf(row: CandidateRow): string {
  const metadata =
    typeof row.metadata === 'object' && row.metadata !== null && !Array.isArray(row.metadata)
      ? row.metadata
      : {};
  const kind = 'kind' in metadata && typeof metadata.kind === 'string' ? metadata.kind : '';
  return `${row.provider}:${kind}`;
}

/**
 * The most recently DATED indexed items, newest first — what to show when
 * there is no query yet, so a knowledge surface reveals what it actually
 * holds instead of an empty box.
 *
 * With several sources selected this returns the newest `k` FROM EACH,
 * rather than the newest k overall. Browsing is a survey, not a ranking:
 * one prolific source would otherwise fill the whole page and the others
 * would read as empty — indistinguishable from not being indexed at all.
 * Search is different and stays a single ranked list, because there the
 * ordering carries real meaning.
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

  const sources = (options.sources ?? []).filter((source) => source.provider.trim());
  const filters = filterFragments(options);
  const owner = ownerScopeFragment(options.verifiers, options.userEmail);
  const overfetch = Math.max(options.k * 2, options.k + 4);

  // One UNION ALL branch per source, each with its own LIMIT, so a quiet
  // source still contributes its newest rows. A single ORDER BY … LIMIT
  // over the union would hand the whole budget to whichever source happens
  // to be most recent.
  const branch = (where: unknown) => sql`
    (SELECT provider, ref_id, content, metadata, source_at, 0 AS distance
     FROM knowledge_chunks
     WHERE tenant_id = ${options.tenantId}
       AND source_at IS NOT NULL
       AND ${where}
       AND ${owner}
       AND ${filters.after}
       AND ${filters.before}
     ORDER BY source_at DESC
     LIMIT ${overfetch})
  `;
  // The trailing ORDER BY re-sorts the merged union. It must NOT appear in
  // the single-branch case: without a set operation, Postgres flattens the
  // parenthesized SELECT and rejects the second sort with "multiple ORDER
  // BY clauses not allowed" — and the branch already orders itself anyway.
  const query =
    sources.length > 1
      ? sql<CandidateRow>`${sql.join(
          sources.map((source) =>
            branch(
              source.kind
                ? sql`(provider = ${source.provider.trim()} AND metadata ->> 'kind' = ${source.kind})`
                : sql`(provider = ${source.provider.trim()})`
            )
          ),
          sql` UNION ALL `
        )} ORDER BY source_at DESC`
      : sql<CandidateRow>`${branch(filters.source)}`;

  const rowsResult = await wrapAsync(() => query.execute(dbResult.val), 'DB_ERROR' as const);
  if (!rowsResult.ok) return rowsResult;

  const outcome = await verifyCandidates(
    options.verifiers,
    options.userEmail,
    rowsResult.val.rows,
    (row) => ({ provider: row.provider, refId: row.ref_id }),
    { budgetMs: options.budgetMs ?? 3_000 }
  );

  // The quota is applied AFTER the gate: culling first and slicing second
  // would let withheld rows eat a source's whole allowance and leave it
  // looking empty when it is merely partly restricted.
  const perSource = new Map<string, number>();
  const kept =
    sources.length > 1
      ? outcome.allowed.filter((row) => {
          const key = sourceKeyOf(row);
          const used = perSource.get(key) ?? 0;
          if (used >= options.k) return false;
          perSource.set(key, used + 1);
          return true;
        })
      : outcome.allowed.slice(0, options.k);

  const contentKey = contentKeyOrNull();
  return ok({
    hits: kept.map((row) => toHit(row, contentKey)),
    elided: outcome.elided,
    unverified: outcome.unverified,
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
  const owner = ownerScopeFragment(options.verifiers, options.userEmail);

  const rowsResult = await wrapAsync(
    () =>
      sql<CandidateRow>`
        SELECT provider, ref_id, content, metadata, source_at,
               (embedding <=> ${vector}::vector) AS distance
        FROM knowledge_chunks
        WHERE tenant_id = ${options.tenantId}
          AND ${filters.source}
          AND ${owner}
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

  const contentKey = contentKeyOrNull();
  return ok({
    hits: outcome.allowed.slice(0, options.k).map((row) => toHit(row, contentKey)),
    elided: outcome.elided,
    unverified: outcome.unverified,
  });
}
