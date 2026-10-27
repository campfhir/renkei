import type { Scenario } from '../../domain';
import type { DataStore } from '../../types';
import type { ChunkCandidate, ChunkFilters } from './types';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const day = (n: number) => new Date(Date.UTC(2026, 0, n));

function chunk(
  n: number,
  provider: string,
  refId: string,
  embedding: number[],
  fields: { sourceAt?: number | null; metadata?: Record<string, unknown>; searchText?: string } = {}
) {
  return {
    id: id(n),
    provider,
    ref_id: refId,
    content: `enc:${n}`,
    embedding: `[${embedding.join(',')}]`,
    metadata: JSON.stringify(fields.metadata ?? {}),
    keywords: n === 1 ? ['printer', 'outage'] : null,
    source_at: fields.sourceAt === null ? null : day(fields.sourceAt ?? n),
    search_text: fields.searchText ?? null,
  };
}

const fixture = {
  knowledge_chunks: [
    chunk(1, 'jira', 'ENG-1', [1, 0, 0], {
      metadata: { kind: 'issue', status: 'Open', version: 12 },
    }),
    chunk(2, 'jira', 'ENG-2', [0.9, 0.3, 0], {
      metadata: { kind: 'issue', status: 'done', version: 3 },
    }),
    chunk(3, 'microsoft', 'scott@example.com/msg/1', [0, 1, 0], {
      metadata: { kind: 'msg', to: ['evan@example.com', 'ann@example.com'] },
    }),
    chunk(4, 'microsoft', 'evan@example.com/msg/2', [0, 0.9, 0.2], { metadata: { kind: 'msg' } }),
    chunk(5, 'microsoft', 'scott@example.com/task/3', [0.5, 0.5, 0.5], {
      metadata: { kind: 'task' },
    }),
    chunk(6, 'confluence', 'page-1#0001', [0.2, 0.1, 0.9], {
      sourceAt: null,
      metadata: { space: 'Engineering', author: { name: 'Ann' } },
    }),
    chunk(7, 'confluence', 'page-1#0002', [0.3, 0.1, 0.8], { metadata: { space: 'Sales' } }),
  ],
};

const none: ChunkFilters = {
  sources: [],
  after: null,
  before: null,
  metadata: null,
  ownerScopedProviders: [],
  ownerEmail: 'scott@example.com',
};

const refs = (rows: ChunkCandidate[]) => rows.map((row) => row.refId);

/** Distances to six places: pgvector accumulates in single precision, memory in double. */
const rounded = (rows: ChunkCandidate[]) =>
  rows.map((row) => ({
    ...row,
    distance: Math.round(row.distance * 1e6) / 1e6,
    score: row.score === null ? null : Math.round(row.score * 1e9) / 1e9,
  }));

const search = { text: 'zzzz', overfetch: 10, rrfK: 60, lexicalConfig: 'english', efSearch: 200 };

export const knowledgeChunkScenarios: Scenario<DataStore>[] = [
  {
    method: 'knowledgeChunks.listRecent',
    name: 'newest dated rows, per source when several, filtered',
    fixture,
    run: async (store) => {
      const recent = (filters: Partial<ChunkFilters>, limit = 10) =>
        store.knowledgeChunks.listRecent({ ...none, ...filters }, limit);
      return [
        await recent({}),
        refs(await recent({}, 2)),
        refs(
          await recent(
            { sources: [{ provider: 'jira' }, { provider: 'microsoft', kind: 'msg' }] },
            1
          )
        ),
        refs(await recent({ sources: [{ provider: ' microsoft ' }, { provider: '' }] })),
        refs(await recent({ after: day(3), before: day(5) })),
        refs(
          await recent({ ownerScopedProviders: ['microsoft'], ownerEmail: '  Scott@Example.com ' })
        ),
        refs(await recent({ sources: [{ provider: 'nobody' }] })),
      ];
    },
  },
  {
    method: 'knowledgeChunks.listRecent',
    name: 'metadata filters as Postgres reads them',
    fixture,
    run: async (store) => {
      const where = (metadata: ChunkFilters['metadata']) =>
        store.knowledgeChunks.listRecent({ ...none, metadata }, 10).then(refs);
      const leaf = (
        key: string,
        operator: '=' | 'contains' | '>' | '<=',
        value: string,
        negated = false
      ) => ({ type: 'filter', filter: { key, operator, value, negated } }) as const;
      return [
        await where(leaf('status', '=', 'open')),
        await where(leaf('status', 'contains', 'ON')),
        await where(leaf('status', '=', 'open', true)),
        await where(leaf('version', '>', '5')),
        await where(leaf('version', '<=', '3')),
        await where(leaf('status', '>', 'm')),
        await where(leaf('to', 'contains', 'evan@')),
        await where(leaf('to', 'contains', '%')),
        await where({
          type: 'or',
          nodes: [leaf('status', '=', 'done'), leaf('kind', '=', 'task')],
        }),
        await where({
          type: 'and',
          nodes: [leaf('kind', '=', 'issue'), leaf('version', '>', '5')],
        }),
        await where({ type: 'and', nodes: [leaf('$message', 'contains', 'printers')] }),
      ];
    },
  },
  {
    method: 'knowledgeChunks.searchHybrid',
    name: 'semantic arm ranked by cosine distance, fused, filtered',
    fixture,
    run: async (store) => {
      const hybrid = (filters: Partial<ChunkFilters>, vector: number[], overfetch = 10) =>
        store.knowledgeChunks
          .searchHybrid({ ...none, ...filters }, { ...search, vector, overfetch })
          .then(rounded);
      return [
        await hybrid({}, [1, 0.1, 0]),
        (await hybrid({}, [0, 1, 0.1], 3)).map((row) => row.refId),
        (await hybrid({ sources: [{ provider: 'confluence' }] }, [0, 0, 1])).map(
          (row) => row.refId
        ),
        (
          await hybrid(
            { ownerScopedProviders: ['microsoft'], sources: [{ provider: 'microsoft' }] },
            [0, 1, 0]
          )
        ).map((row) => row.refId),
        (
          await hybrid(
            {
              metadata: { type: 'filter', filter: { key: 'space', operator: '=', value: 'sales' } },
            },
            [0, 0, 1]
          )
        ).map((row) => row.refId),
        await hybrid({ sources: [{ provider: 'nobody' }] }, [1, 0, 0]),
      ];
    },
  },
];
