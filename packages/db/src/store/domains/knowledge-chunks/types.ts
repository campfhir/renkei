import type { MetadataFilterExpr } from './metadata-filter';

export type {
  MetadataFilterExpr,
  MetadataFilterOperator,
  MetadataFilterToken,
} from './metadata-filter';

/** One selectable source: a provider, optionally pinned to a single `metadata.kind`. */
export interface ChunkSource {
  provider: string;
  kind?: string;
}

/** What narrows a candidate set, shared by the hybrid search and the recency browse. */
export interface ChunkFilters {
  /** OR-ed; empty means every source. Providers are compared trimmed; blank ones are dropped. */
  sources: readonly ChunkSource[];
  /** Only rows dated on/after `after` and before `before`; undated rows are excluded by either. */
  after: Date | null;
  before: Date | null;
  metadata: MetadataFilterExpr | null;
  /**
   * Providers whose whole ACL is the ref's owner prefix: their rows are
   * proposed only when `ref_id` starts with `ownerEmail/` (lower-cased).
   */
  ownerScopedProviders: readonly string[];
  ownerEmail: string;
}

/** A proposed chunk, still ciphertext and still unverified — the gate decides what is shown. */
export interface ChunkCandidate {
  provider: string;
  refId: string;
  /** As stored (encrypted at rest). */
  content: string;
  /** Parsed JSON, unread. */
  metadata: unknown;
  keywords: string[] | null;
  sourceAt: Date | null;
  /** Cosine distance to the query; 0 on a browse row. */
  distance: number;
  /** The fused rank score (search only). */
  score: number | null;
  semanticHit: boolean | null;
  lexicalHit: boolean | null;
}

/** One chunk as an ingest writes it; `content` arrives sealed, the rest plaintext. */
export interface KnowledgeChunkUpsert {
  provider: string;
  refId: string;
  metadata: Record<string, unknown>;
  /** As stored (encrypted at rest). */
  content: string;
  embedding: readonly number[];
  keywords: string[] | null;
  /**
   * The lexical index's inputs, in plaintext: title (weight A), keywords
   * (B), chunk text (C), under the text search configuration `config`.
   * Postgres builds the tsvector; memory keeps the words lower-cased,
   * which is all its lexical arm reads.
   */
  search: { title: string; keywords: string; content: string; config: string };
  sourceAt: Date | null;
}

/**
 * The knowledge index (`knowledge_chunks`), read for retrieval. It only
 * proposes: every candidate still goes through the live ACL gate in
 * @renkei/knowledge before anything is disclosed.
 */
export interface KnowledgeChunkStore {
  /**
   * The newest DATED chunks, newest first, at most `limit` — per source
   * when more than one source is named (one branch each, merged newest
   * first), so a quiet source still contributes. Memory breaks ties on
   * `source_at` by id; Postgres leaves them unordered.
   */
  listRecent(filters: ChunkFilters, limit: number): Promise<ChunkCandidate[]>;
  /**
   * Hybrid retrieval: a semantic arm (cosine distance to `vector`) and a
   * lexical arm (full-text match of `query`), each taking its top
   * `overfetch`, fused by reciprocal rank (`rrfK`), best first, at most
   * `overfetch`.
   *
   * Postgres runs pgvector and `websearch_to_tsquery` as before. Memory
   * approximates both: an exact cosine distance in double precision
   * (pgvector accumulates in single precision, so distances agree to
   * about six digits), and a lexical arm that matches a row when every
   * word of the query, lower-cased, appears in its stored `search_text`,
   * ranked by how many times they do — no stemming, phrases or operators.
   * The two agree on rows with no `search_text` (neither arm-two matches)
   * and on well-separated distances, which is what the differential
   * scenarios use.
   */
  searchHybrid(
    filters: ChunkFilters,
    query: {
      vector: readonly number[];
      text: string;
      overfetch: number;
      rrfK: number;
      /** The text search configuration the index was built with (Postgres only). */
      lexicalConfig: string;
      /** `hnsw.ef_search` for this query (Postgres only). */
      efSearch: number;
    }
  ): Promise<ChunkCandidate[]>;

  /**
   * Write one chunk, replacing the stored one with the same (provider,
   * ref id) — metadata, content, embedding, keywords, lexical entry and
   * source date all — and keeping its id and creation time.
   */
  upsert(chunk: KnowledgeChunkUpsert): Promise<void>;
  /**
   * Delete one object's chunks — the bare ref id and every `refId#…` — or,
   * `prefixOnly`, every ref id starting with `refId`. Returns how many went.
   */
  deleteObject(
    provider: string,
    refId: string,
    options?: { prefixOnly?: boolean }
  ): Promise<number>;
  /** Delete the provider's chunks whose `metadata ->> key` is `value`; returns how many. */
  deleteByMetadata(provider: string, key: string, value: string): Promise<number>;
  /**
   * Delete a scope's chunks (`metadata ->> scope.key` = value) whose epoch
   * (`metadata ->> epoch.key`) is anything but `epoch.value`, missing
   * included; returns how many.
   */
  deleteStaleScope(
    provider: string,
    scope: { key: string; value: string },
    epoch: { key: string; value: string }
  ): Promise<number>;
  /** The metadata of the named objects' chunks (bare ref ids and their `#` chunks), by ref id. */
  objectMetadata(
    provider: string,
    refIds: readonly string[]
  ): Promise<{ refId: string; metadata: unknown }[]>;
  /**
   * The smallest cosine distance from `vector` to a chunk under
   * `refIdPrefix`, created at or after `since`, other than `excludeRefId`
   * and its `#` chunks; null when there is none. Postgres asks pgvector;
   * memory computes the distance in JavaScript, agreeing to about six
   * digits (see searchHybrid).
   */
  nearestDistance(
    vector: readonly number[],
    scope: { refIdPrefix: string; excludeRefId: string; since: Date }
  ): Promise<number | null>;
}
