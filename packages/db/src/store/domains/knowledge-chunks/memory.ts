import { like, orderBy, page } from '../../memory/order';
import type { MemoryTables, Row } from '../../memory/tables';
import { metadataMatches, metadataText } from './metadata-filter';
import { escapeLike, liveSources, objectChunkFromRow, withoutNul } from './postgres';
import type { ChunkCandidate, ChunkFilters, ChunkSource, KnowledgeChunkStore } from './types';
import { jsonbConcat } from '../provider-grants/record';

type Chunk = Row<'knowledge_chunks'>;

function inSource(row: Chunk, source: ChunkSource): boolean {
  return (
    row.provider === source.provider.trim() &&
    (!source.kind || metadataText(row.metadata, 'kind') === source.kind)
  );
}

/** Every filter but the sources, which the browse applies per branch. */
function passes(row: Chunk, filters: ChunkFilters): boolean {
  if (filters.ownerScopedProviders.includes(row.provider)) {
    const ownPrefix = `${escapeLike(filters.ownerEmail.trim().toLowerCase())}/%`;
    if (!like(row.ref_id, ownPrefix, true)) return false;
  }
  const at = row.source_at?.getTime() ?? null;
  if (filters.after && (at === null || at < filters.after.getTime())) return false;
  if (filters.before && (at === null || at >= filters.before.getTime())) return false;
  return metadataMatches(row.metadata, filters.metadata);
}

function inAnySource(row: Chunk, filters: ChunkFilters): boolean {
  const sources = liveSources(filters);
  return sources.length === 0 || sources.some((source) => inSource(row, source));
}

/** pgvector's text form, `[1,2,3]`, back to numbers. */
function parseVector(text: string): number[] {
  return text
    .replace(/^\[|\]$/g, '')
    .split(',')
    .filter((part) => part.trim() !== '')
    .map(Number);
}

/**
 * `<=>`: 1 − cosine similarity, the way pgvector computes it — float4
 * elements and single-precision sums, the ratio in double, clamped.
 */
function cosineDistance(left: readonly number[], right: readonly number[]): number {
  const f = Math.fround;
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let i = 0; i < Math.min(left.length, right.length); i += 1) {
    const a = f(left[i]);
    const b = f(right[i]);
    dot = f(dot + f(a * b));
    leftNorm = f(leftNorm + f(a * a));
    rightNorm = f(rightNorm + f(b * b));
  }
  const similarity = dot / Math.sqrt(leftNorm * rightNorm);
  return 1 - Math.min(1, Math.max(-1, similarity));
}

/** The memory lexical arm: how often the query's words occur in the stored search text. */
function lexicalScore(row: Chunk, words: string[]): number {
  if (row.search_text === null || words.length === 0) return 0;
  const haystack = row.search_text.toLowerCase();
  let total = 0;
  for (const word of words) {
    const count = haystack.split(word).length - 1;
    if (count === 0) return 0;
    total += count;
  }
  return total;
}

function candidate(row: Chunk, fields: Partial<ChunkCandidate>): ChunkCandidate {
  return {
    provider: row.provider,
    refId: row.ref_id,
    content: row.content,
    metadata: row.metadata ?? null,
    keywords: row.keywords,
    sourceAt: row.source_at,
    distance: 0,
    score: null,
    semanticHit: null,
    lexicalHit: null,
    ...fields,
  };
}

export function memoryKnowledgeChunks(tables: MemoryTables): KnowledgeChunkStore {
  return {
    async listRecent(filters, limit) {
      const dated = tables.select(
        'knowledge_chunks',
        (row) => row.source_at !== null && passes(row, filters)
      );
      const newest = (rows: Chunk[]) =>
        page(orderBy(rows, [(row) => row.source_at, 'desc'], [(row) => row.id]), limit);
      const sources = liveSources(filters);
      const picked =
        sources.length > 1
          ? orderBy(
              sources.flatMap((source) => newest(dated.filter((row) => inSource(row, source)))),
              [(row) => row.source_at, 'desc'],
              [(row) => row.id]
            )
          : newest(dated.filter((row) => inAnySource(row, filters)));
      return picked.map((row) => candidate(row, {}));
    },

    async searchHybrid(filters, { vector, text, overfetch, rrfK }) {
      const rows = tables.select(
        'knowledge_chunks',
        (row) => inAnySource(row, filters) && passes(row, filters)
      );
      const distances = new Map(
        rows.map((row) => [row.id, cosineDistance(parseVector(row.embedding), vector)])
      );
      const semantic = page(
        orderBy(rows, [(row) => distances.get(row.id), 'asc'], [(row) => row.id]),
        overfetch
      );
      const words = text
        .toLowerCase()
        .split(/[^\p{L}\p{N}]+/u)
        .filter(Boolean);
      const scored = rows
        .map((row) => ({ row, score: lexicalScore(row, words) }))
        .filter((entry) => entry.score > 0);
      const lexical = page(
        orderBy(scored, [(entry) => entry.score, 'desc'], [(entry) => entry.row.id]),
        overfetch
      ).map((entry) => entry.row);

      const semanticRank = new Map(semantic.map((row, index) => [row.id, index + 1]));
      const lexicalRank = new Map(lexical.map((row, index) => [row.id, index + 1]));
      const fused = [
        ...new Map([...semantic, ...lexical].map((row) => [row.id, row])).values(),
      ].map((row) => {
        const semanticAt = semanticRank.get(row.id);
        const lexicalAt = lexicalRank.get(row.id);
        return candidate(row, {
          distance: distances.get(row.id) ?? 0,
          score:
            (semanticAt === undefined ? 0 : 1 / (rrfK + semanticAt)) +
            (lexicalAt === undefined ? 0 : 1 / (rrfK + lexicalAt)),
          semanticHit: semanticAt !== undefined,
          lexicalHit: lexicalAt !== undefined,
        });
      });
      return page(
        orderBy(fused, [(hit) => hit.score, 'desc'], [(hit) => hit.distance], [(hit) => hit.refId]),
        overfetch
      );
    },
    async upsert(chunk) {
      const values = {
        metadata: JSON.stringify(chunk.metadata),
        content: chunk.content,
        embedding: `[${chunk.embedding.join(',')}]`,
        keywords: chunk.keywords,
        search_text: [chunk.search.title, chunk.search.keywords, chunk.search.content]
          .join(' ')
          .toLowerCase(),
        source_at: chunk.sourceAt,
      };
      tables.upsert(
        'knowledge_chunks',
        {
          id: globalThis.crypto.randomUUID(),
          provider: chunk.provider,
          ref_id: chunk.refId,
          ...values,
        },
        ['provider', 'ref_id'],
        values
      );
    },
    async deleteObject(provider, refId, options = {}) {
      const pattern = options.prefixOnly ? `${escapeLike(refId)}%` : `${escapeLike(refId)}#%`;
      return tables.delete(
        'knowledge_chunks',
        (r) =>
          r.provider === provider &&
          (like(r.ref_id, pattern, true) || (!options.prefixOnly && r.ref_id === refId))
      ).length;
    },
    async deleteByMetadata(provider, key, value) {
      return tables.delete(
        'knowledge_chunks',
        (r) => r.provider === provider && metadataText(r.metadata, key) === value
      ).length;
    },
    async deleteStaleScope(provider, scope, epoch) {
      return tables.delete(
        'knowledge_chunks',
        (r) =>
          r.provider === provider &&
          metadataText(r.metadata, scope.key) === scope.value &&
          metadataText(r.metadata, epoch.key) !== epoch.value
      ).length;
    },
    async objectMetadata(provider, refIds) {
      if (refIds.length === 0) return [];
      const patterns = refIds.map((refId) => `${escapeLike(refId)}#%`);
      const rows = tables.select(
        'knowledge_chunks',
        (r) =>
          r.provider === provider &&
          (refIds.includes(r.ref_id) || patterns.some((p) => like(r.ref_id, p, true)))
      );
      return orderBy(rows, [(r) => r.ref_id]).map((row) => ({
        refId: row.ref_id,
        metadata: row.metadata ?? null,
      }));
    },
    async nearestDistance(vector, scope) {
      const prefix = `${escapeLike(scope.refIdPrefix)}%`;
      const own = `${escapeLike(scope.excludeRefId)}#%`;
      const distances = tables
        .select(
          'knowledge_chunks',
          (r) =>
            like(r.ref_id, prefix, true) &&
            r.ref_id !== scope.excludeRefId &&
            !like(r.ref_id, own, true) &&
            r.created_at.getTime() >= scope.since.getTime()
        )
        .map((r) => cosineDistance(parseVector(r.embedding), vector));
      return distances.length === 0 ? null : Math.min(...distances);
    },
    async objectChunks(provider, refId) {
      const rows = tables.select(
        'knowledge_chunks',
        (r) => r.provider === provider && (r.ref_id === refId || r.ref_id.startsWith(`${refId}#`))
      );
      return orderBy(rows, [(r) => r.ref_id], [(r) => r.id]).map(objectChunkFromRow);
    },
    async rewriteChunk(id, { title, keywords, lexical }) {
      const searchText = [lexical.title, (lexical.keywords ?? []).join(', '), lexical.text]
        .map(withoutNul)
        .join(' ');
      const key = tables.param('knowledge_chunks', 'id', id);
      tables.update(
        'knowledge_chunks',
        (r) => r.id === key,
        (r) => ({
          ...(title !== undefined
            ? { metadata: JSON.stringify(jsonbConcat(r.metadata, { title })) }
            : {}),
          keywords,
          search_text: searchText,
        })
      );
    },
    async listByRefPrefix(provider, prefix) {
      const rows = tables.select(
        'knowledge_chunks',
        (r) => r.provider === provider && r.ref_id.startsWith(prefix)
      );
      return orderBy(rows, [(r) => r.source_at, 'desc'], [(r) => r.ref_id], [(r) => r.id]).map(
        objectChunkFromRow
      );
    },
    async deleteSourcedBetween(provider, scope) {
      const from = scope.from.getTime();
      const to = scope.to.getTime();
      return tables.delete(
        'knowledge_chunks',
        (r) =>
          r.provider === provider &&
          r.ref_id.startsWith(scope.refIdPrefix) &&
          !r.ref_id.startsWith(scope.exceptRefIdPrefix) &&
          r.source_at !== null &&
          new Date(r.source_at).getTime() >= from &&
          new Date(r.source_at).getTime() < to
      ).length;
    },
  };
}
