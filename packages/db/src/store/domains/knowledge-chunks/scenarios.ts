import type { Scenario } from '../../domain';
import { toJson } from '../../memory/tables';
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
    metadata: toJson(fields.metadata ?? {}),
    keywords: n === 1 ? ['printer', 'outage'] : null,
    source_at: fields.sourceAt === null ? null : day(fields.sourceAt ?? n),
    search_text: fields.searchText ?? null,
    created_at: day(n),
  };
}

const fixture = {
  knowledge_chunks: [
    chunk(1, 'jira', 'ENG-1', [1, 0, 0], {
      metadata: { kind: 'issue', status: 'open', version: 12 },
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

function note(n: number, refId: string, sourceAt: number | null, provider = 'notes') {
  return {
    id: id(n),
    provider,
    ref_id: refId,
    content: `enc:${n}`,
    embedding: '[1,0,0]',
    metadata: { title: `t${n}`, kind: 'note' },
    keywords: ['a'],
    source_at: sourceAt === null ? null : day(sourceAt),
    search_text: 'old',
  };
}

const notesFixture = {
  knowledge_chunks: [
    note(41, 'ann@x.test/n1', 3),
    note(42, 'ann@x.test/n1#0002', 3),
    note(43, 'ann@x.test/n10', 5),
    note(44, 'ann@x.test/n2', null),
    note(45, 'ann@x.test/n1', 3, 'jira'),
    note(46, 'bob@x.test/n1', 9),
  ],
};

/** Rows for the reindex sweeps: some unsearchable, some multi-chunk, some keyword-less, some plaintext. */
const reindexFixture = {
  knowledge_chunks: [
    {
      ...chunk(51, 'reindex', 'doc-1#0001', [1, 0, 0], { metadata: { chunkCount: 2 } }),
      content: 'renc1:a',
    },
    {
      ...chunk(52, 'reindex', 'doc-1#0002', [0.9, 0.1, 0], { metadata: { chunkCount: '2' } }),
      content: 'plain one',
    },
    {
      ...chunk(53, 'reindex', 'doc-2', [0, 1, 0], {
        metadata: { chunkCount: 1 },
        searchText: 'already',
      }),
      content: 'plain two',
      keywords: ['k'],
    },
    {
      ...chunk(54, 'alpha', 'Z-9#0001', [0, 1, 0], { searchText: 'indexed' }),
      content: 'renc_x',
    },
    {
      ...chunk(55, 'reindex', 'doc-3#12345', [0, 0.5, 0.5], { metadata: { chunkCount: 3 } }),
      content: 'renc1:b',
      keywords: ['k'],
    },
  ],
};

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
  {
    method: 'knowledgeChunks.upsert',
    name: 'insert, then replace in place by (provider, ref id)',
    fixture,
    run: async (store) => {
      const base = {
        provider: 'note',
        refId: 'ann@example.com/n1',
        metadata: { title: 'First' },
        content: 'enc:new',
        embedding: [1, 0, 0],
        keywords: null,
        search: { title: 'First', keywords: '', content: 'hello world', config: 'english' },
        sourceAt: day(20),
      };
      await store.knowledgeChunks.upsert(base);
      await store.knowledgeChunks.upsert({
        ...base,
        provider: 'jira',
        refId: 'ENG-1',
        metadata: { kind: 'issue', status: 'closed' },
        content: 'enc:replaced',
        keywords: ['printer'],
        sourceAt: day(21),
      });
      const recent = await store.knowledgeChunks.listRecent(none, 3);
      return recent.map((row) => [
        row.provider,
        row.refId,
        row.content,
        row.metadata,
        row.keywords,
        row.sourceAt,
      ]);
    },
  },
  {
    method: 'knowledgeChunks.deleteObject',
    name: 'bare ref and its chunks, or a whole prefix; other providers untouched',
    fixture,
    run: async (store) => [
      await store.knowledgeChunks.deleteObject('confluence', 'page-1'),
      await store.knowledgeChunks.deleteObject('jira', 'ENG-1'),
      await store.knowledgeChunks.deleteObject('microsoft', 'scott@example.com/', {
        prefixOnly: true,
      }),
      await store.knowledgeChunks.deleteObject('jira', 'ENG_'),
      refs(await store.knowledgeChunks.listRecent(none, 20)),
    ],
  },
  {
    method: 'knowledgeChunks.deleteByMetadata',
    name: 'by one metadata key, within a provider',
    fixture,
    run: async (store) => [
      await store.knowledgeChunks.deleteByMetadata('confluence', 'space', 'Sales'),
      await store.knowledgeChunks.deleteByMetadata('jira', 'version', '12'),
      await store.knowledgeChunks.deleteByMetadata('jira', 'missing', 'x'),
      refs(await store.knowledgeChunks.listRecent(none, 20)),
    ],
  },
  {
    method: 'knowledgeChunks.deleteStaleScope',
    name: 'the scope minus the current epoch; a missing epoch counts as stale',
    fixture: {
      knowledge_chunks: [
        chunk(11, 'sharepoint', 'd/1', [1, 0, 0], { metadata: { scopeKey: 'd', epoch: 'e2' } }),
        chunk(12, 'sharepoint', 'd/2', [1, 0, 0], { metadata: { scopeKey: 'd', epoch: 'e1' } }),
        chunk(13, 'sharepoint', 'd/3', [1, 0, 0], { metadata: { scopeKey: 'd' } }),
        chunk(14, 'sharepoint', 'x/1', [1, 0, 0], { metadata: { scopeKey: 'x', epoch: 'e1' } }),
      ],
    },
    run: async (store) => [
      await store.knowledgeChunks.deleteStaleScope(
        'sharepoint',
        { key: 'scopeKey', value: 'd' },
        { key: 'epoch', value: 'e2' }
      ),
      refs(await store.knowledgeChunks.listRecent(none, 20)),
    ],
  },
  {
    method: 'knowledgeChunks.objectMetadata',
    name: 'bare refs and their chunks, by ref id',
    fixture,
    run: async (store) => [
      await store.knowledgeChunks.objectMetadata('confluence', ['page-1']),
      await store.knowledgeChunks.objectMetadata('jira', ['ENG-2', 'ENG-1', 'ENG-9']),
      await store.knowledgeChunks.objectMetadata('jira', []),
      await store.knowledgeChunks.objectMetadata('microsoft', ['ENG-1']),
    ],
  },
  {
    method: 'knowledgeChunks.nearestDistance',
    name: 'nearest in the namespace, the object itself excluded',
    fixture,
    run: async (store) => {
      const since = new Date(Date.UTC(2000, 0, 1));
      const round = (value: number | null) =>
        value === null ? null : Math.round(value * 1e6) / 1e6;
      return [
        round(
          await store.knowledgeChunks.nearestDistance([0, 1, 0], {
            refIdPrefix: 'scott@example.com/',
            excludeRefId: 'scott@example.com/msg/1',
            since,
          })
        ),
        round(
          await store.knowledgeChunks.nearestDistance([0, 1, 0], {
            refIdPrefix: 'scott@example.com/',
            excludeRefId: 'scott@example.com/other',
            since,
          })
        ),
        await store.knowledgeChunks.nearestDistance([0, 1, 0], {
          refIdPrefix: 'nobody@example.com/',
          excludeRefId: 'x',
          since,
        }),
        await store.knowledgeChunks.nearestDistance([0, 1, 0], {
          refIdPrefix: 'scott@example.com/',
          excludeRefId: 'x',
          since: new Date(Date.UTC(2999, 0, 1)),
        }),
      ];
    },
  },
  {
    method: 'knowledgeChunks.objectChunks',
    name: 'the object and its #-suffixed chunks, never a longer id or another provider',
    fixture: notesFixture,
    run: async (store) => [
      await store.knowledgeChunks.objectChunks('notes', 'ann@x.test/n1'),
      (await store.knowledgeChunks.objectChunks('notes', 'ann@x.test/n_')).map((c) => c.refId),
      await store.knowledgeChunks.objectChunks('jira', 'ann@x.test/n1'),
    ],
  },
  {
    method: 'knowledgeChunks.rewriteChunk',
    name: 'title merged into metadata, keywords and search text replaced; untitled leaves metadata',
    fixture: notesFixture,
    run: async (store) => {
      await store.knowledgeChunks.rewriteChunk(id(41), {
        title: 'Renamed',
        keywords: ['k'],
        lexical: { config: 'english', title: 'Renamed', keywords: ['k'], text: 'zebra crossing' },
      });
      await store.knowledgeChunks.rewriteChunk(id(42), {
        keywords: null,
        lexical: { config: 'english', title: 't42', keywords: null, text: 'plain\u0000text' },
      });
      // The rebuilt lexical entry is searchable: only the rewritten chunk matches.
      const hits = await store.knowledgeChunks.searchHybrid(
        { ...none, sources: [{ provider: 'notes' }] },
        { ...search, vector: [1, 0, 0], text: 'zebra' }
      );
      return {
        chunks: await store.knowledgeChunks.objectChunks('notes', 'ann@x.test/n1'),
        lexical: hits
          .map((hit) => ({ refId: hit.refId, lexicalHit: hit.lexicalHit }))
          .sort((a, b) => (a.refId < b.refId ? -1 : a.refId > b.refId ? 1 : 0)),
      };
    },
  },
  {
    method: 'knowledgeChunks.listByRefPrefix',
    name: 'newest first with undated first, by ref id; the prefix is literal',
    fixture: notesFixture,
    run: async (store) => [
      (await store.knowledgeChunks.listByRefPrefix('notes', 'ann@x.test/')).map((c) => c.refId),
      await store.knowledgeChunks.listByRefPrefix('notes', 'bob@x.test/'),
      await store.knowledgeChunks.listByRefPrefix('notes', 'ann_x'),
    ],
  },
  {
    method: 'knowledgeChunks.deleteSourcedBetween',
    name: "the window's dated rows under the prefix, the excepted prefix and other days kept",
    fixture: {
      knowledge_chunks: [
        chunk(1, 'webex', 'room-a/msg-1', [1, 0, 0], { sourceAt: 5 }),
        chunk(2, 'webex', 'room-a/msg-2#0001', [1, 0, 0], { sourceAt: 5 }),
        chunk(3, 'webex', 'room-a/day/2026-01-05', [1, 0, 0], { sourceAt: 5 }),
        chunk(4, 'webex', 'room-a/msg-3', [1, 0, 0], { sourceAt: 6 }),
        chunk(5, 'webex', 'room-a/msg-4', [1, 0, 0], { sourceAt: 4 }),
        chunk(6, 'webex', 'room-a/msg-5', [1, 0, 0], { sourceAt: null }),
        chunk(7, 'webex', 'room-ab/msg-6', [1, 0, 0], { sourceAt: 5 }),
        chunk(8, 'webex', 'roomb/msg-7', [1, 0, 0], { sourceAt: 5 }),
        chunk(9, 'zoom', 'room-a/msg-8', [1, 0, 0], { sourceAt: 5 }),
      ],
    },
    run: async (store) => {
      const removed = await store.knowledgeChunks.deleteSourcedBetween('webex', {
        refIdPrefix: 'room-a/',
        exceptRefIdPrefix: 'room-a/day/',
        from: day(5),
        to: day(6),
      });
      const none = await store.knowledgeChunks.deleteSourcedBetween('webex', {
        refIdPrefix: 'room-z/',
        exceptRefIdPrefix: 'room-z/day/',
        from: day(1),
        to: day(9),
      });
      return {
        removed,
        none,
        webex: (await store.knowledgeChunks.listByRefPrefix('webex', 'room')).map((c) => c.refId),
        zoom: (await store.knowledgeChunks.listByRefPrefix('zoom', 'room')).map((c) => c.refId),
      };
    },
  },
  {
    method: 'knowledgeChunks.listUnsearchable',
    name: 'chunks without a lexical entry, by id, limited',
    fixture: reindexFixture,
    run: async (store) => [
      (await store.knowledgeChunks.listUnsearchable(10)).map((c) => c.id),
      await store.knowledgeChunks.listUnsearchable(1),
    ],
  },
  {
    method: 'knowledgeChunks.setSearchText',
    name: 'a rebuilt entry is searchable, an empty one matches nothing; both leave the backlog',
    fixture: reindexFixture,
    run: async (store) => {
      await store.knowledgeChunks.setSearchText(id(51), {
        title: 'Printer runbook',
        keywords: 'hardware',
        content: 'zebra toner',
        config: 'english',
      });
      await store.knowledgeChunks.setSearchText(id(52), null);
      const hits = await store.knowledgeChunks.searchHybrid(
        { ...none, sources: [{ provider: 'reindex' }] },
        { ...search, vector: [1, 0, 0], text: 'zebra' }
      );
      return {
        backlog: (await store.knowledgeChunks.listUnsearchable(10)).map((c) => c.id),
        lexical: hits
          .filter((hit) => hit.lexicalHit)
          .map((hit) => hit.refId)
          .sort(),
      };
    },
  },
  {
    method: 'knowledgeChunks.listMultiChunk',
    name: 'chunkCount above one, after the cursor, by id; limited; past the end',
    fixture: reindexFixture,
    run: async (store) => [
      (await store.knowledgeChunks.listMultiChunk(null, 10)).map((c) => c.id),
      (await store.knowledgeChunks.listMultiChunk(id(51), 10)).map((c) => c.id),
      await store.knowledgeChunks.listMultiChunk(null, 1),
      await store.knowledgeChunks.listMultiChunk(id(99), 10),
    ],
  },
  {
    method: 'knowledgeChunks.setEmbedding',
    name: 'the new vector is what the semantic arm measures',
    fixture: reindexFixture,
    run: async (store) => {
      await store.knowledgeChunks.setEmbedding(id(53), [0, 0, 1]);
      const nearest = await store.knowledgeChunks.searchHybrid(
        { ...none, sources: [{ provider: 'reindex' }] },
        { ...search, vector: [0, 0, 1], overfetch: 1 }
      );
      return nearest.map((hit) => ({ refId: hit.refId, distance: Math.round(hit.distance * 1e6) }));
    },
  },
  {
    method: 'knowledgeChunks.listObjectsWithoutKeywords',
    name: 'objects (chunk suffix stripped) with a keyword-less chunk, by provider then ref; limited',
    fixture: reindexFixture,
    run: async (store) => [
      await store.knowledgeChunks.listObjectsWithoutKeywords(10),
      await store.knowledgeChunks.listObjectsWithoutKeywords(2),
    ],
  },
  {
    method: 'knowledgeChunks.listContentWithoutPrefix',
    name: 'content not starting with the prefix, by id; limited; the prefix is literal',
    fixture: reindexFixture,
    run: async (store) => [
      await store.knowledgeChunks.listContentWithoutPrefix('renc1:', 10),
      await store.knowledgeChunks.listContentWithoutPrefix('renc1:', 1),
      (await store.knowledgeChunks.listContentWithoutPrefix('renc_', 10)).map((c) => c.id),
    ],
  },
  {
    method: 'knowledgeChunks.setContent',
    name: 'content replaced; the chunk leaves the plaintext backlog',
    fixture: reindexFixture,
    run: async (store) => {
      await store.knowledgeChunks.setContent(id(52), 'renc1:sealed');
      return [
        (await store.knowledgeChunks.listContentWithoutPrefix('renc1:', 10)).map((c) => c.id),
        (await store.knowledgeChunks.objectChunks('reindex', 'doc-1')).map((c) => c.content),
      ];
    },
  },
];
