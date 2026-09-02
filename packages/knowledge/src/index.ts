/**
 * @renkei/knowledge — the minimal knowledge layer (RENKEI.md Phase 1).
 *
 * Ingestion embeds a chunk and upserts it with its durable SourceRef;
 * retrieval embeds the query, PROPOSES candidates by cosine distance fused
 * with a lexical ranking, and passes every candidate through the live ACL
 * gate (@renkei/gates, Decisions #14/#18) before anything is returned. The
 * index is never authorization; the gate is.
 */

import { compileMetadataFilter, type MetadataFilterExpr } from './metadata-filter';
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
import { LEXICAL_CONFIG } from './ingest';

export {
  EMBEDDINGS_CONNECTOR,
  OpenAiCompatibleEmbeddings,
  resolveEmbeddingProvider,
  resolveKnowledge,
  parseMaxDistance,
  vectorLiteral,
  type EmbeddingProvider,
  type EmbeddingPurpose,
  type EmbeddingOptions,
  type KnowledgeTuning,
  type KnowledgeProvider,
} from './embeddings';

export {
  chunkText,
  chunkRefId,
  deleteObjectChunks,
  deleteChunksByMetadata,
  readObjectMetadataBatch,
  deleteStaleScopeChunks,
  ingestObjectChunks,
  embeddingInputs,
  type ChunkTextOptions,
} from './chunking';

export {
  ingestChunk,
  upsertChunkRow,
  searchTextFragment,
  LEXICAL_CONFIG,
  type KnowledgeChunkInput,
} from './ingest';

export { titleOf, chunkContext, embeddingInput } from './context';

export {
  resolveKeywordExtractor,
  createLlmKeywordExtractor,
  parseKeywords,
  keywordPrompt,
  KEYWORD_INPUT_MAX_CHARS,
  MAX_KEYWORDS,
  type KeywordExtractor,
  type KeywordExtractorOptions,
} from './keywords';

export {
  relevanceOf,
  RELEVANCE_LABELS,
  DEFAULT_RELEVANCE_BANDS,
  type Relevance,
} from './relevance';

export {
  NOTE_KNOWLEDGE_PROVIDER,
  AUTHORED_PROVIDERS,
  NOTE_CHUNKING,
  noteRefId,
  ownerOfNoteRefId,
  createNoteAccessVerifier,
} from './note';

/**
 * Which arm(s) of retrieval proposed a hit. `lexical` alone means the
 * words matched but the vector did not rank it — the exact-identifier case
 * hybrid search exists for; its distance is reported but was not what
 * found it. `none` is a browse row, where no query was involved.
 */
export type MatchKind = 'semantic' | 'lexical' | 'both' | 'none';

export interface KnowledgeHit {
  provider: string;
  refId: string;
  content: string;
  metadata: Record<string, unknown>;
  /** Cosine distance — smaller is closer. */
  distance: number;
  /**
   * The fused rank score that ordered the list — larger is better. Only
   * meaningful relative to the other hits of the same search; a browse
   * row carries 0.
   */
  score: number;
  matched: MatchKind;
  /** The object's LLM-extracted search terms (keywords.ts); empty when none were extracted. */
  keywords: string[];
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
  /**
   * Candidates the vector proposed beyond `maxDistance` with no lexical
   * match to vouch for them — dropped before the gate (never verified,
   * never disclosed) and counted, so a caller can say "there were weaker
   * matches" instead of presenting nothing as if nothing were near.
   */
  weak: number;
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
  /** `key:value` narrowing over metadata — see metadata-filter.ts. */
  metadata?: MetadataFilterExpr | null;
  /**
   * Cosine distance past which a semantic-only candidate is dropped and
   * counted in `weak` (KnowledgeTuning.maxDistance). A candidate the
   * lexical arm matched is kept whatever its distance: an exact token
   * match is precisely the case where the vector is wrong about distance.
   * Omitted/null means no cutoff.
   */
  maxDistance?: number | null;
  /**
   * Collapse the chunks of one document to its best-ranked chunk, so `k`
   * counts documents rather than pieces of the same long one. Done BEFORE
   * the gate: a document's chunks share an ACL, so verifying one answers
   * for all, and the verifiers' budget is spent on distinct objects.
   */
  perDocument?: boolean;
}

interface CandidateRow {
  provider: string;
  ref_id: string;
  content: string;
  metadata: unknown;
  distance: number;
  source_at: Date | string | null;
  keywords?: unknown;
  /** Present on search rows; absent on browse rows. */
  score?: number | string | null;
  semantic_hit?: boolean | null;
  lexical_hit?: boolean | null;
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
  /** `key:value` narrowing over metadata — see metadata-filter.ts. */
  metadata?: MetadataFilterExpr | null;
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
  const metadata = compileMetadataFilter(filters.metadata);
  return {
    source: clauses.length > 0 ? sql`(${sql.join(clauses, sql` OR `)})` : sql`TRUE`,
    // A dated filter excludes undated rows rather than treating NULL as epoch.
    after: after ? sql`source_at IS NOT NULL AND source_at >= ${after}` : sql`TRUE`,
    before: before ? sql`source_at IS NOT NULL AND source_at < ${before}` : sql`TRUE`,
    metadata: metadata ?? sql`TRUE`,
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

/** The content key once per query; null renders every hit as unavailable. */
function contentKeyOrNull(): Buffer | null {
  const keyResult = contentEncryptionKey();
  return keyResult.ok ? keyResult.val : null;
}

function matchKindOf(row: CandidateRow): MatchKind {
  const semantic = row.semantic_hit === true;
  const lexical = row.lexical_hit === true;
  if (semantic && lexical) return 'both';
  if (lexical) return 'lexical';
  if (semantic) return 'semantic';
  return 'none';
}

function toHit(row: CandidateRow, contentKey: Buffer | null): KnowledgeHit {
  const score = Number(row.score ?? 0);
  return {
    provider: row.provider,
    refId: row.ref_id,
    // Stored ciphertext → plaintext for the caller; the row was already
    // ACL-verified before reaching here.
    content: revealContent(row.content, contentKey),
    metadata:
      typeof row.metadata === 'object' && row.metadata !== null && !Array.isArray(row.metadata)
        ? { ...row.metadata }
        : {},
    distance: Number(row.distance),
    score: Number.isFinite(score) ? score : 0,
    matched: matchKindOf(row),
    keywords: Array.isArray(row.keywords)
      ? row.keywords.filter((keyword): keyword is string => typeof keyword === 'string')
      : [],
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
    (SELECT provider, ref_id, content, metadata, keywords, source_at, 0 AS distance
     FROM knowledge_chunks
     WHERE tenant_id = ${options.tenantId}
       AND source_at IS NOT NULL
       AND ${where}
       AND ${owner}
       AND ${filters.after}
       AND ${filters.before}
       AND ${filters.metadata}
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
    weak: 0,
  });
}

/**
 * Reciprocal rank fusion's smoothing constant. 60 is the value the
 * original paper settled on and what every hybrid-search implementation
 * since has used; it makes a first-place rank in one arm worth about the
 * same as a top-few rank in both, which is the behaviour wanted here — a
 * chunk both arms like should beat a chunk only one arm loves.
 */
const RRF_K = 60;

/**
 * Candidates fetched per arm before fusion and the gate. Larger than the
 * old 2k because two things now eat into it: the gate denies some, and
 * per-document collapsing folds a long document's several chunks into one
 * slot. Capped so a live verifier (Atlassian, SharePoint) is never asked
 * about more refs than it can answer for inside the gate's budget.
 */
const MAX_OVERFETCH = 60;

/** The logical document a chunk row belongs to — its refId before the `#0001` suffix. */
function documentKeyOf(row: CandidateRow): string {
  const hash = row.ref_id.indexOf('#');
  return `${row.provider}:${hash > 0 ? row.ref_id.slice(0, hash) : row.ref_id}`;
}

export async function searchKnowledge(
  options: SearchOptions
): Promise<Result<KnowledgeSearchResult, 'EMBEDDING_FAILED' | 'DB_ERROR'>> {
  const embedded = await options.embedder.embed([options.query], 'query');
  if (!embedded.ok) return embedded;
  const vector = vectorLiteral(embedded.val[0] ?? []);

  const dbResult = getDatabase();
  if (!dbResult.ok) return err('DB_ERROR' as const);

  const overfetch = Math.min(MAX_OVERFETCH, Math.max(options.k * 4, options.k + 16));

  // Every narrowing predicate belongs HERE, not in a post-fetch filter: the
  // query returns only `overfetch` rows per arm, so filtering afterwards
  // would discard most of an already-small candidate set and starve the
  // result list. The one post-fetch step below (the distance cutoff)
  // truncates the tail rather than narrowing the set, which is different.
  const filters = filterFragments(options);
  const owner = ownerScopeFragment(options.verifiers, options.userEmail);
  const where = sql`
        tenant_id = ${options.tenantId}
          AND ${filters.source}
          AND ${owner}
          AND ${filters.after}
          AND ${filters.before}
          AND ${filters.metadata}`;

  // Two arms, one query. The semantic arm ranks by cosine distance; the
  // lexical arm ranks by ts_rank_cd over the weighted tsvector (title
  // first) for a websearch-style parse of the raw query — quoted phrases,
  // -exclusions and OR all mean what a person expects. Rows a lexical
  // backfill has not reached (search_text NULL) simply never match that
  // arm. The fused score is RRF over the two rank positions; a row only one
  // arm proposed scores as if the other ranked it nowhere.
  const rowsResult = await wrapAsync(
    () =>
      sql<CandidateRow>`
        WITH semantic AS (
          SELECT id,
                 (embedding <=> ${vector}::vector) AS distance,
                 row_number() OVER (ORDER BY embedding <=> ${vector}::vector) AS rank
          FROM knowledge_chunks
          WHERE ${where}
          ORDER BY distance
          LIMIT ${overfetch}
        ),
        lexical AS (
          SELECT id,
                 row_number() OVER (ORDER BY ts_rank_cd(search_text, query) DESC) AS rank
          FROM knowledge_chunks, websearch_to_tsquery(${LEXICAL_CONFIG}::regconfig, ${options.query}) AS query
          WHERE ${where}
            AND search_text @@ query
          ORDER BY ts_rank_cd(search_text, query) DESC
          LIMIT ${overfetch}
        ),
        fused AS (
          SELECT COALESCE(semantic.id, lexical.id) AS id,
                 COALESCE(1.0 / (${RRF_K} + semantic.rank), 0)
                   + COALESCE(1.0 / (${RRF_K} + lexical.rank), 0) AS score,
                 semantic.distance AS distance,
                 (semantic.id IS NOT NULL) AS semantic_hit,
                 (lexical.id IS NOT NULL) AS lexical_hit
          FROM semantic FULL OUTER JOIN lexical ON semantic.id = lexical.id
        )
        SELECT c.provider, c.ref_id, c.content, c.metadata, c.keywords, c.source_at,
               COALESCE(fused.distance, c.embedding <=> ${vector}::vector) AS distance,
               fused.score, fused.semantic_hit, fused.lexical_hit
        FROM fused JOIN knowledge_chunks c ON c.id = fused.id
        ORDER BY fused.score DESC, distance ASC
        LIMIT ${overfetch}
      `.execute(dbResult.val),
    'DB_ERROR' as const
  );
  if (!rowsResult.ok) return rowsResult;

  const maxDistance =
    typeof options.maxDistance === 'number' &&
    Number.isFinite(options.maxDistance) &&
    options.maxDistance > 0
      ? options.maxDistance
      : null;

  let weak = 0;
  const seenDocuments = new Set<string>();
  const candidates = rowsResult.val.rows.filter((row) => {
    if (
      options.excludeRef &&
      row.provider === options.excludeRef.provider &&
      row.ref_id === options.excludeRef.refId
    ) {
      return false;
    }
    // The cutoff applies to what the vector alone proposed. A lexical
    // match vouches for a row whatever its distance — that IS the case
    // the lexical arm exists for.
    if (maxDistance !== null && row.lexical_hit !== true && Number(row.distance) > maxDistance) {
      weak += 1;
      return false;
    }
    if (options.perDocument) {
      const key = documentKeyOf(row);
      if (seenDocuments.has(key)) return false;
      seenDocuments.add(key);
    }
    return true;
  });

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
    weak,
  });
}

export {
  compileMetadataFilter,
  splitQuery,
  FREE_TEXT_KEY,
  type MetadataFilterExpr,
  type MetadataFilterOperator,
  type MetadataFilterToken,
} from './metadata-filter';
