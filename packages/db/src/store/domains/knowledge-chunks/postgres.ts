import { sql, type Kysely } from 'kysely';
import type { DB } from '../../../db.types';
import { compileMetadataFilter } from './metadata-filter';
import type {
  ChunkCandidate,
  ChunkFilters,
  ChunkSource,
  KnowledgeChunkStore,
  KnowledgeObjectChunk,
} from './types';

/** A row as either retrieval query returns it. */
interface CandidateRow {
  provider: string;
  ref_id: string;
  content: string;
  metadata: unknown;
  keywords: string[] | null;
  source_at: Date | string | null;
  distance: number | string;
  score?: number | string | null;
  semantic_hit?: boolean | null;
  lexical_hit?: boolean | null;
}

function candidateFromRow(row: CandidateRow): ChunkCandidate {
  const sourceAt =
    row.source_at === null || row.source_at === undefined ? null : new Date(row.source_at);
  return {
    provider: row.provider,
    refId: row.ref_id,
    content: row.content,
    metadata: row.metadata ?? null,
    keywords: row.keywords ?? null,
    sourceAt,
    distance: Number(row.distance),
    score: row.score === undefined || row.score === null ? null : Number(row.score),
    semanticHit: row.semantic_hit ?? null,
    lexicalHit: row.lexical_hit ?? null,
  };
}

export function objectChunkFromRow(row: {
  id: string;
  ref_id: string;
  content: string;
  metadata: unknown;
  keywords: string[] | null;
  source_at: Date | null;
}): KnowledgeObjectChunk {
  return {
    id: row.id,
    refId: row.ref_id,
    content: row.content,
    metadata: row.metadata ?? null,
    keywords: row.keywords ?? null,
    sourceAt: row.source_at ? new Date(row.source_at) : null,
  };
}

/** Text as Postgres accepts it in a `text` parameter: NUL bytes out. */
export function withoutNul(value: string): string {
  return value.includes('\u0000') ? value.split('\u0000').join('') : value;
}

const OBJECT_CHUNK_COLUMNS = [
  'id',
  'ref_id',
  'content',
  'metadata',
  'keywords',
  'source_at',
] as const;

export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

/** The sources that name a provider at all — blank entries mean "no filter", not "match nothing". */
export function liveSources(filters: ChunkFilters): ChunkSource[] {
  return filters.sources.filter((source) => source.provider.trim());
}

function sourceClause(source: ChunkSource) {
  return source.kind
    ? sql`(provider = ${source.provider.trim()} AND metadata ->> 'kind' = ${source.kind})`
    : sql`(provider = ${source.provider.trim()})`;
}

/**
 * The WHERE fragments for the filters, each a no-op `TRUE` when absent so
 * the unfiltered plan stays identical. Built once and shared so browse and
 * search can never disagree about what a filter means.
 */
function filterFragments(filters: ChunkFilters) {
  // Each source contributes one AND-ed pair; the pairs are OR-ed together,
  // so a mixed selection means what it says rather than intersecting.
  const clauses = liveSources(filters).map(sourceClause);
  const metadata = compileMetadataFilter(filters.metadata);
  return {
    source: clauses.length > 0 ? sql`(${sql.join(clauses, sql` OR `)})` : sql`TRUE`,
    // A dated filter excludes undated rows rather than treating NULL as epoch.
    after: filters.after ? sql`source_at IS NOT NULL AND source_at >= ${filters.after}` : sql`TRUE`,
    before: filters.before
      ? sql`source_at IS NOT NULL AND source_at < ${filters.before}`
      : sql`TRUE`,
    metadata: metadata ?? sql`TRUE`,
  };
}

/**
 * The proposal-side half of ownerScoped verifiers: providers whose whole
 * ACL is the ref's owner prefix admit only the requester's own rows. The
 * predicate mirrors the verifiers' parse exactly: owner is everything
 * before the first `/`, compared lowercased.
 */
function ownerScopeFragment(filters: ChunkFilters) {
  const scoped = filters.ownerScopedProviders.map((provider) => sql`${provider}`);
  if (scoped.length === 0) return sql`TRUE`;
  const ownPrefix = `${escapeLike(filters.ownerEmail.trim().toLowerCase())}/%`;
  return sql`(provider NOT IN (${sql.join(scoped, sql`, `)}) OR ref_id LIKE ${ownPrefix})`;
}

export function postgresKnowledgeChunks(db: () => Kysely<DB>): KnowledgeChunkStore {
  return {
    async listRecent(filters, limit) {
      const sources = liveSources(filters);
      const fragments = filterFragments(filters);
      const owner = ownerScopeFragment(filters);

      // One UNION ALL branch per source, each with its own LIMIT, so a quiet
      // source still contributes its newest rows. A single ORDER BY … LIMIT
      // over the union would hand the whole budget to whichever source happens
      // to be most recent.
      const branch = (where: unknown) => sql`
        (SELECT provider, ref_id, content, metadata, keywords, source_at, 0 AS distance
         FROM knowledge_chunks
         WHERE source_at IS NOT NULL
           AND ${where}
           AND ${owner}
           AND ${fragments.after}
           AND ${fragments.before}
           AND ${fragments.metadata}
         ORDER BY source_at DESC
         LIMIT ${limit})
      `;
      // The trailing ORDER BY re-sorts the merged union. It must NOT appear in
      // the single-branch case: without a set operation, Postgres flattens the
      // parenthesized SELECT and rejects the second sort with "multiple ORDER
      // BY clauses not allowed" — and the branch already orders itself anyway.
      const query =
        sources.length > 1
          ? sql<CandidateRow>`${sql.join(
              sources.map((source) => branch(sourceClause(source))),
              sql` UNION ALL `
            )} ORDER BY source_at DESC`
          : sql<CandidateRow>`${branch(fragments.source)}`;
      const result = await query.execute(db());
      return result.rows.map(candidateFromRow);
    },

    async searchHybrid(
      filters,
      { vector: values, text, overfetch, rrfK, lexicalConfig, efSearch }
    ) {
      const vector = `[${values.join(',')}]`;
      // Every narrowing predicate belongs HERE, not in a post-fetch filter:
      // the query returns only `overfetch` rows per arm, so filtering
      // afterwards would discard most of an already-small candidate set.
      const fragments = filterFragments(filters);
      const owner = ownerScopeFragment(filters);
      const where = sql`
        ${fragments.source}
          AND ${owner}
          AND ${fragments.after}
          AND ${fragments.before}
          AND ${fragments.metadata}`;

      // Two arms, one query. The semantic arm ranks by cosine distance; the
      // lexical arm ranks by ts_rank_cd over the weighted tsvector (title
      // first) for a websearch-style parse of the raw query. Rows a lexical
      // backfill has not reached (search_text NULL) never match that arm.
      // The fused score is RRF over the two rank positions; a row only one
      // arm proposed scores as if the other ranked it nowhere.
      const rows = await db()
        .transaction()
        .execute(async (trx) => {
          // SET LOCAL: scoped to this transaction only, so it can never leak
          // onto a later query that reuses the same pooled connection.
          await sql`SET LOCAL hnsw.ef_search = ${sql.raw(String(efSearch))}`.execute(trx);
          return sql<CandidateRow>`
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
            FROM knowledge_chunks, websearch_to_tsquery(${lexicalConfig}::regconfig, ${text}) AS query
            WHERE ${where}
              AND search_text @@ query
            ORDER BY ts_rank_cd(search_text, query) DESC
            LIMIT ${overfetch}
          ),
          fused AS (
            SELECT COALESCE(semantic.id, lexical.id) AS id,
                   COALESCE(1.0 / (${rrfK} + semantic.rank), 0)
                     + COALESCE(1.0 / (${rrfK} + lexical.rank), 0) AS score,
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
        `.execute(trx);
        });
      return rows.rows.map(candidateFromRow);
    },
    async upsert(chunk) {
      const vector = `[${chunk.embedding.join(',')}]`;
      const tsvector = (text: string) =>
        sql<string>`to_tsvector(${chunk.search.config}::regconfig, ${text})`;
      const searchText = sql<string>`setweight(${tsvector(chunk.search.title)}, 'A') || setweight(${tsvector(chunk.search.keywords)}, 'B') || setweight(${tsvector(chunk.search.content)}, 'C')`;
      const metadata = JSON.stringify(chunk.metadata);
      await db()
        .insertInto('knowledge_chunks')
        .values({
          id: globalThis.crypto.randomUUID(),
          provider: chunk.provider,
          ref_id: chunk.refId,
          metadata,
          content: chunk.content,
          embedding: sql`${vector}::vector`,
          keywords: chunk.keywords,
          search_text: searchText,
          source_at: chunk.sourceAt,
        })
        .onConflict((oc) =>
          // source_at must be in the update set too: a re-ingest of an edited
          // page carries a newer document date, and omitting it here would
          // pin the row to whatever date the first ingest saw.
          oc.columns(['provider', 'ref_id']).doUpdateSet({
            metadata,
            content: chunk.content,
            embedding: sql`${vector}::vector`,
            keywords: chunk.keywords,
            search_text: searchText,
            source_at: chunk.sourceAt,
          })
        )
        .execute();
    },
    async deleteObject(provider, refId, options = {}) {
      const pattern = options.prefixOnly ? `${escapeLike(refId)}%` : `${escapeLike(refId)}#%`;
      const result = await db()
        .deleteFrom('knowledge_chunks')
        .where('provider', '=', provider)
        .where((eb) =>
          options.prefixOnly
            ? eb('ref_id', 'like', pattern)
            : eb.or([eb('ref_id', '=', refId), eb('ref_id', 'like', pattern)])
        )
        .executeTakeFirst();
      return Number(result.numDeletedRows ?? 0);
    },
    async deleteByMetadata(provider, key, value) {
      const result = await db()
        .deleteFrom('knowledge_chunks')
        .where('provider', '=', provider)
        .where(sql<boolean>`metadata ->> ${key} = ${value}`)
        .executeTakeFirst();
      return Number(result.numDeletedRows ?? 0);
    },
    async deleteStaleScope(provider, scope, epoch) {
      const result = await db()
        .deleteFrom('knowledge_chunks')
        .where('provider', '=', provider)
        .where(sql<boolean>`metadata ->> ${scope.key} = ${scope.value}`)
        .where(sql<boolean>`metadata ->> ${epoch.key} IS DISTINCT FROM ${epoch.value}`)
        .executeTakeFirst();
      return Number(result.numDeletedRows ?? 0);
    },
    async objectMetadata(provider, refIds) {
      if (refIds.length === 0) return [];
      const patterns = refIds.map((refId) => `${escapeLike(refId)}#%`);
      const rows = await db()
        .selectFrom('knowledge_chunks')
        .select(['ref_id', 'metadata'])
        .where('provider', '=', provider)
        .where((eb) =>
          eb.or([eb('ref_id', 'in', [...refIds]), sql<boolean>`ref_id LIKE ANY(${patterns})`])
        )
        .orderBy('ref_id')
        .execute();
      return rows.map((row) => ({ refId: row.ref_id, metadata: row.metadata ?? null }));
    },
    async nearestDistance(vector, scope) {
      const literal = `[${vector.join(',')}]`;
      const result = await sql<{ distance: number }>`
        SELECT (embedding <=> ${literal}::vector) AS distance
        FROM knowledge_chunks
        WHERE ref_id LIKE ${`${escapeLike(scope.refIdPrefix)}%`}
          AND ref_id <> ${scope.excludeRefId}
          AND ref_id NOT LIKE ${`${escapeLike(scope.excludeRefId)}#%`}
          AND created_at >= ${scope.since}
        ORDER BY distance
        LIMIT 1
      `.execute(db());
      const distance = result.rows[0]?.distance;
      return distance === undefined || distance === null ? null : Number(distance);
    },
    async objectChunks(provider, refId) {
      const rows = await db()
        .selectFrom('knowledge_chunks')
        .select(OBJECT_CHUNK_COLUMNS)
        .where('provider', '=', provider)
        .where((eb) =>
          eb.or([eb('ref_id', '=', refId), eb('ref_id', 'like', `${escapeLike(refId)}#%`)])
        )
        .orderBy('ref_id')
        .orderBy('id')
        .execute();
      return rows.map(objectChunkFromRow);
    },
    async rewriteChunk(id, { title, keywords, lexical }) {
      const vector = (text: string) =>
        sql<string>`to_tsvector(${lexical.config}::regconfig, ${withoutNul(text)})`;
      const phrases = (lexical.keywords ?? []).join(', ');
      await db()
        .updateTable('knowledge_chunks')
        .set({
          ...(title !== undefined
            ? { metadata: sql`metadata || jsonb_build_object('title', ${title}::text)` }
            : {}),
          keywords,
          search_text: sql<string>`setweight(${vector(lexical.title)}, 'A') || setweight(${vector(phrases)}, 'B') || setweight(${vector(lexical.text)}, 'C')`,
        })
        .where('id', '=', id)
        .execute();
    },
    async listByRefPrefix(provider, prefix) {
      const rows = await db()
        .selectFrom('knowledge_chunks')
        .select(OBJECT_CHUNK_COLUMNS)
        .where('provider', '=', provider)
        .where('ref_id', 'like', `${escapeLike(prefix)}%`)
        .orderBy('source_at', 'desc')
        .orderBy('ref_id')
        .orderBy('id')
        .execute();
      return rows.map(objectChunkFromRow);
    },
    async listUnsearchable(limit) {
      const rows = await db()
        .selectFrom('knowledge_chunks')
        .select(OBJECT_CHUNK_COLUMNS)
        .where('search_text', 'is', null)
        .orderBy('id')
        .limit(limit)
        .execute();
      return rows.map(objectChunkFromRow);
    },
    async setSearchText(id, search) {
      const tsvector = (config: string, text: string) =>
        sql<string>`to_tsvector(${config}::regconfig, ${text})`;
      await db()
        .updateTable('knowledge_chunks')
        .set({
          search_text: search
            ? sql<string>`setweight(${tsvector(search.config, search.title)}, 'A') || setweight(${tsvector(search.config, search.keywords)}, 'B') || setweight(${tsvector(search.config, search.content)}, 'C')`
            : sql<string>`to_tsvector('')`,
        })
        .where('id', '=', id)
        .execute();
    },
    async listMultiChunk(after, limit) {
      let query = db()
        .selectFrom('knowledge_chunks')
        .select(OBJECT_CHUNK_COLUMNS)
        // Only multi-chunk rows carry a header; ingest stamps `chunkCount`
        // on exactly those.
        .where(sql<boolean>`(metadata ->> 'chunkCount')::int > 1`);
      if (after) query = query.where('id', '>', after);
      const rows = await query.orderBy('id').limit(limit).execute();
      return rows.map(objectChunkFromRow);
    },
    async setEmbedding(id, embedding) {
      await db()
        .updateTable('knowledge_chunks')
        .set({ embedding: sql`${`[${embedding.join(',')}]`}::vector` })
        .where('id', '=', id)
        .execute();
    },
    async listObjectsWithoutKeywords(limit) {
      /** The logical object a chunk row belongs to: its ref before the `#0001` suffix. */
      const objectRef = sql<string>`regexp_replace(ref_id, '#[0-9]{4}$', '')`;
      const rows = await db()
        .selectFrom('knowledge_chunks')
        .select(['provider', objectRef.as('object_ref')])
        .where('keywords', 'is', null)
        .groupBy(['provider', objectRef])
        .orderBy('provider')
        .orderBy(objectRef)
        .limit(limit)
        .execute();
      return rows.map((row) => ({ provider: row.provider, objectRef: row.object_ref }));
    },
    async listContentWithoutPrefix(prefix, limit) {
      return db()
        .selectFrom('knowledge_chunks')
        .select(['id', 'content'])
        .where('content', 'not like', `${escapeLike(prefix)}%`)
        .orderBy('id')
        .limit(limit)
        .execute();
    },
    async setContent(id, content) {
      await db().updateTable('knowledge_chunks').set({ content }).where('id', '=', id).execute();
    },
  };
}
