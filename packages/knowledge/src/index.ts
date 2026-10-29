/**
 * @renkei/knowledge — the minimal knowledge layer (RENKEI.md Phase 1).
 *
 * Ingestion embeds a chunk and upserts it with its durable SourceRef;
 * retrieval embeds the query, PROPOSES candidates by cosine distance fused
 * with a lexical ranking, and passes every candidate through the live ACL
 * gate (@renkei/gates, Decisions #14/#18) before anything is returned. The
 * index is never authorization; the gate is.
 */

import type { MetadataFilterExpr } from './metadata-filter';
import { getDataStore, type ChunkCandidate, type ChunkFilters } from '@renkei/db';
import { contentEncryptionKey, revealContent } from '@renkei/crypto';
import { verifyCandidates } from '@renkei/gates';
import type { AccessVerifier, SourceRef } from '@renkei/gates';
import { ok, wrapAsync } from '@campfhir/safe-functions/helpers';
import type { Result } from '@campfhir/safe-functions/types';
import type { EmbeddingProvider } from './embeddings';
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
  escapeLike,
  type ChunkTextOptions,
} from './chunking';

export {
  ingestChunk,
  upsertChunkRow,
  searchTextParts,
  postgresText,
  LEXICAL_CONFIG,
  type KnowledgeChunkInput,
} from './ingest';

export { titleOf, chunkContext, embeddingInput } from './context';

export {
  resolveKeywordExtractor,
  createLlmKeywordExtractor,
  parseKeywords,
  normalizeKeywords,
  keywordPrompt,
  KEYWORD_INPUT_MAX_CHARS,
  MAX_KEYWORDS,
  type KeywordExtractor,
  type KeywordExtractorOptions,
} from './keywords';

export {
  reindexLexicalBatch,
  reembedBatch,
  extractKeywordsBatch,
  isReindexKind,
  REINDEX_KINDS,
  type ReindexKind,
  type BatchOutcome,
} from './reindex';

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

/** Where a search's time went, in milliseconds per phase. */
export interface SearchTimings {
  /** Embedding the query at the org's endpoint; 0 for a browse, which needs none. */
  embedMs: number;
  /** The candidate query against Postgres. */
  queryMs: number;
  /** The live access gate, bounded by its budget. */
  verifyMs: number;
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
  /**
   * How long each phase took. Retrieval is three round trips of very
   * different kinds, and a slow search is fixed differently depending on
   * which one it was — so callers can log the split, not just the sum.
   */
  timings: SearchTimings;
}

export interface SearchOptions {
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
 * The filters as the store takes them: dates parsed (a malformed one is
 * ignored rather than matching nothing), and the providers whose verifiers
 * are ownerScoped — the proposal-side half of those verifiers (see
 * AccessVerifier). Providers whose whole ACL is the ref's owner prefix
 * admit only the requester's own rows into the candidate set: foreign-owned
 * rows would be withheld by the gate anyway, but fetching them still counts
 * them — and a withheld tally of a coworker's mailbox is itself a
 * disclosure, besides eating overfetch slots that owned rows could have
 * filled. Providers without the flag — including providers with no verifier
 * at all — pass through untouched, so live-verified content and deployment
 * bugs are still counted honestly.
 */
function chunkFilters(
  filters: CandidateFilters,
  verifiers: ReadonlyMap<string, AccessVerifier>,
  userEmail: string
): ChunkFilters {
  return {
    sources: filters.sources ?? [],
    after: boundary(filters.after),
    before: boundary(filters.before),
    metadata: filters.metadata ?? null,
    ownerScopedProviders: [...verifiers.values()]
      .filter((verifier) => verifier.ownerScoped)
      .map((verifier) => verifier.provider),
    ownerEmail: userEmail,
  };
}

/** The content key once per query; null renders every hit as unavailable. */
function contentKeyOrNull(): Buffer | null {
  const keyResult = contentEncryptionKey();
  return keyResult.ok ? keyResult.val : null;
}

function matchKindOf(row: ChunkCandidate): MatchKind {
  const semantic = row.semanticHit === true;
  const lexical = row.lexicalHit === true;
  if (semantic && lexical) return 'both';
  if (lexical) return 'lexical';
  if (semantic) return 'semantic';
  return 'none';
}

function toHit(row: ChunkCandidate, contentKey: Buffer | null): KnowledgeHit {
  const score = Number(row.score ?? 0);
  return {
    provider: row.provider,
    refId: row.refId,
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
    sourceAt: sourceAtIso(row.sourceAt),
  };
}

export interface RecentOptions extends CandidateFilters {
  /** Whose access the gate verifies. Nothing is disclosed without it. */
  userEmail: string;
  k: number;
  verifiers: ReadonlyMap<string, AccessVerifier>;
  budgetMs?: number;
}

/** The source a row belongs to, for per-source quotas. */
function sourceKeyOf(row: ChunkCandidate): string {
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
  const sources = (options.sources ?? []).filter((source) => source.provider.trim());
  const overfetch = Math.max(options.k * 2, options.k + 4);

  // One branch per source, each with its own limit, so a quiet source still
  // contributes its newest rows (the store's listRecent).
  const queryStarted = Date.now();
  const rowsResult = await wrapAsync(
    () =>
      getDataStore().knowledgeChunks.listRecent(
        chunkFilters(options, options.verifiers, options.userEmail),
        overfetch
      ),
    'DB_ERROR' as const
  );
  if (!rowsResult.ok) return rowsResult;
  const queryMs = Date.now() - queryStarted;

  const verifyStarted = Date.now();
  const outcome = await verifyCandidates(
    options.verifiers,
    options.userEmail,
    rowsResult.val,
    (row) => ({ provider: row.provider, refId: row.refId }),
    { budgetMs: options.budgetMs ?? 3_000 }
  );
  const verifyMs = Date.now() - verifyStarted;

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
    timings: { embedMs: 0, queryMs, verifyMs },
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

/**
 * `hnsw.ef_search` — the size of the candidate list the HNSW index explores
 * per query. pgvector defaults this to 40, which is already smaller than
 * MAX_OVERFETCH (60), and every search here is FILTERED (tenant, source,
 * owner, dates, metadata all live in the same WHERE as the vector order).
 * HNSW's graph traversal has no idea about that WHERE clause — it explores
 * neighbours in raw embedding space and only checks the filter afterward —
 * so a filtered query needs a larger candidate list than an unfiltered one
 * to end up with the same number of qualifying rows. Left at the default,
 * a real result can simply never be visited: a query narrowed to one quiet
 * source, or one noisy source OR-ed in beside it, can silently lose a
 * genuinely close match to a denser, irrelevant cluster (a large mailbox,
 * a large ticket backlog) that the traversal happened to explore instead.
 * Set well above MAX_OVERFETCH so there is real headroom for that filter
 * cost, not just enough to cover the LIMIT itself.
 */
const HNSW_EF_SEARCH = 200;

/** The logical document a chunk row belongs to — its refId before the `#0001` suffix. */
function documentKeyOf(row: ChunkCandidate): string {
  const hash = row.refId.indexOf('#');
  return `${row.provider}:${hash > 0 ? row.refId.slice(0, hash) : row.refId}`;
}

export async function searchKnowledge(
  options: SearchOptions
): Promise<Result<KnowledgeSearchResult, 'EMBEDDING_FAILED' | 'DB_ERROR'>> {
  const embedStarted = Date.now();
  const embedded = await options.embedder.embed([options.query], 'query');
  if (!embedded.ok) return embedded;
  const embedMs = Date.now() - embedStarted;
  const overfetch = Math.min(MAX_OVERFETCH, Math.max(options.k * 4, options.k + 16));

  // Every narrowing predicate is applied by the store's query, not in a
  // post-fetch filter: it returns only `overfetch` rows per arm, so
  // filtering afterwards would discard most of an already-small candidate
  // set and starve the result list. The one post-fetch step below (the
  // distance cutoff) truncates the tail rather than narrowing the set,
  // which is different.
  const queryStarted = Date.now();
  const rowsResult = await wrapAsync(
    () =>
      getDataStore().knowledgeChunks.searchHybrid(
        chunkFilters(options, options.verifiers, options.userEmail),
        {
          vector: embedded.val[0] ?? [],
          text: options.query,
          overfetch,
          rrfK: RRF_K,
          lexicalConfig: LEXICAL_CONFIG,
          efSearch: HNSW_EF_SEARCH,
        }
      ),
    'DB_ERROR' as const
  );
  if (!rowsResult.ok) return rowsResult;
  const queryMs = Date.now() - queryStarted;

  const maxDistance =
    typeof options.maxDistance === 'number' &&
    Number.isFinite(options.maxDistance) &&
    options.maxDistance > 0
      ? options.maxDistance
      : null;

  let weak = 0;
  const seenDocuments = new Set<string>();
  const candidates = rowsResult.val.filter((row) => {
    if (
      options.excludeRef &&
      row.provider === options.excludeRef.provider &&
      row.refId === options.excludeRef.refId
    ) {
      return false;
    }
    // The cutoff applies to what the vector alone proposed. A lexical
    // match vouches for a row whatever its distance — that IS the case
    // the lexical arm exists for.
    if (maxDistance !== null && row.lexicalHit !== true && row.distance > maxDistance) {
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

  const verifyStarted = Date.now();
  const outcome = await verifyCandidates(
    options.verifiers,
    options.userEmail,
    candidates,
    (row) => ({ provider: row.provider, refId: row.refId }),
    { budgetMs: options.budgetMs ?? 3_000 }
  );
  const verifyMs = Date.now() - verifyStarted;

  const contentKey = contentKeyOrNull();
  return ok({
    hits: outcome.allowed.slice(0, options.k).map((row) => toHit(row, contentKey)),
    elided: outcome.elided,
    unverified: outcome.unverified,
    weak,
    timings: { embedMs, queryMs, verifyMs },
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
