import type { Scenario } from '../../domain';
import type { DataStore } from '../../types';
import type { LibraryFilter } from './types';
import { ANN, BOB, CHAT, PROJECT, at, chatWorld, uid } from '../chats/fixtures';

const A = {
  annUpload: uid(1001),
  annModel: uid(1002),
  annLibrary: uid(1003),
  bobShared: uid(1004),
  bobPrivate: uid(1005),
  annOcr: uid(1006),
  annSame: uid(1007),
};

function artifact(id: string, owner: string, minute: number, extra: Record<string, unknown> = {}) {
  return {
    id,
    owner_subject: owner,
    blob_key: `blob/${id}`,
    filename: `file-${minute}.txt`,
    content_type: 'text/plain',
    size_bytes: String(minute * 100),
    created_at: at(minute),
    updated_at: at(minute),
    ...extra,
  };
}

const world = chatWorld();
const fixture = {
  ...world,
  artifacts: [
    artifact(A.annUpload, ANN, 1, {
      chat_id: CHAT.annA,
      filename: 'Invoices_March.pdf',
      content_type: 'application/pdf',
      extracted_text: 'sealed-text-é',
      key_kind: 'chat',
      key_ref: CHAT.annA,
    }),
    artifact(A.annModel, ANN, 2, { chat_id: CHAT.annA, origin: 'model', filename: 'chart.png' }),
    artifact(A.annLibrary, ANN, 3, {
      summary: 'Quarterly budget review',
      keywords: ['finance'],
      digest_status: 'done',
      search_vector: "'budget':2B 'financ':1A 'quarter':1B 'review':3B",
    }),
    artifact(A.bobShared, BOB, 4, { filename: 'bob invoice.csv' }),
    artifact(A.bobPrivate, BOB, 5),
    artifact(A.annOcr, ANN, 6, {
      ocr_started_at: at(7),
      ocr_finished_at: at(8),
      ocr_millis: 900,
      ocr_pages: 3,
    }),
    artifact(A.annSame, ANN, 6, { chat_id: CHAT.annA, filename: 'chart.png', ocr_millis: 50 }),
  ],
  artifact_references: [
    {
      id: uid(1101),
      artifact_id: A.annLibrary,
      project_id: PROJECT.annChat,
      mode: 'always',
      added_by: ANN,
      created_at: at(2),
    },
    {
      id: uid(1102),
      artifact_id: A.annUpload,
      project_id: PROJECT.annChat,
      added_by: ANN,
      created_at: at(1),
    },
    {
      id: uid(1103),
      artifact_id: A.annLibrary,
      project_id: PROJECT.bobChat,
      added_by: BOB,
      created_at: at(3),
    },
  ],
};

const filter = (overrides: Partial<LibraryFilter> = {}): LibraryFilter => ({
  viewerSubject: ANN,
  sharedIds: [A.bobShared],
  show: 'all',
  projectId: null,
  query: '',
  terms: [],
  ...overrides,
});
const ids = (rows: { id: string }[]) => rows.map((row) => row.id);

export const artifactScenarios: Scenario<DataStore>[] = [
  {
    method: 'artifacts.get',
    name: 'whole record; missing',
    fixture,
    run: async (store) => [await store.artifacts.get(A.annOcr), await store.artifacts.get(uid(1))],
  },
  {
    method: 'artifacts.getMany',
    name: 'oldest first, ties by id, unknown left out',
    fixture,
    run: async (store) => [
      ids(await store.artifacts.getMany([A.annSame, A.annOcr, A.annUpload, uid(1)])),
      await store.artifacts.getMany([]),
    ],
  },
  {
    method: 'artifacts.listByChat',
    name: 'per chat, by origin',
    fixture,
    run: async (store) => [
      ids(await store.artifacts.listByChat(CHAT.annA)),
      ids(await store.artifacts.listByChat(CHAT.annA, { origin: 'model' })),
      await store.artifacts.listByChat(CHAT.annB),
    ],
  },
  {
    method: 'artifacts.findInChat',
    name: "by id or newest by name, owner's own only",
    fixture,
    run: async (store) => {
      const find = (input: { ownerSubject: string; id: string | null; filename: string | null }) =>
        store.artifacts.findInChat({ chatId: CHAT.annA, ...input }).then((row) => row?.id ?? null);
      return [
        await find({ ownerSubject: ANN, id: A.annUpload, filename: null }),
        await find({ ownerSubject: ANN, id: null, filename: 'chart.png' }),
        await find({ ownerSubject: BOB, id: A.annUpload, filename: null }),
        await find({ ownerSubject: ANN, id: null, filename: null }),
        await find({ ownerSubject: ANN, id: null, filename: 'nope' }),
      ];
    },
  },
  {
    method: 'artifacts.getText',
    name: 'sealed text or null',
    fixture,
    run: async (store) => [
      await store.artifacts.getText(A.annUpload),
      await store.artifacts.getText(A.annModel),
      await store.artifacts.getText(uid(1)),
    ],
  },
  {
    method: 'artifacts.textLengths',
    name: 'characters, zero without text',
    fixture,
    run: async (store) => [
      await store.artifacts.textLengths([A.annModel, A.annUpload, uid(1)]),
      await store.artifacts.textLengths([]),
    ],
  },
  {
    method: 'artifacts.alwaysTextLengths',
    name: "the project's always files, one left out",
    fixture: {
      ...fixture,
      artifact_references: [
        ...fixture.artifact_references,
        {
          id: uid(1104),
          artifact_id: A.annUpload,
          project_id: PROJECT.bobChat,
          mode: 'always',
          added_by: BOB,
          created_at: at(4),
        },
      ],
    },
    run: async (store) => [
      await store.artifacts.alwaysTextLengths(PROJECT.annChat, null),
      await store.artifacts.alwaysTextLengths(PROJECT.bobChat, null),
      await store.artifacts.alwaysTextLengths(PROJECT.bobChat, A.annUpload),
    ],
  },
  {
    method: 'artifacts.listForProject',
    name: 'in attach order, with the reference',
    fixture,
    run: async (store) => [
      await store.artifacts.listForProject(PROJECT.annChat),
      await store.artifacts.listForProject(PROJECT.annCode),
    ],
  },
  {
    method: 'artifacts.getForProject',
    name: 'held or not',
    fixture,
    run: async (store) => [
      (await store.artifacts.getForProject(PROJECT.bobChat, A.annLibrary))?.referenceId,
      await store.artifacts.getForProject(PROJECT.bobChat, A.annUpload),
    ],
  },
  {
    method: 'artifacts.listReferences',
    name: 'every project holding it',
    fixture,
    run: async (store) => [
      await store.artifacts.listReferences(A.annLibrary),
      await store.artifacts.listReferences(A.bobPrivate),
    ],
  },
  {
    method: 'artifacts.referenceCounts',
    name: 'held ones only',
    fixture,
    run: async (store) => [
      await store.artifacts.referenceCounts([A.annUpload, A.annLibrary, A.bobPrivate]),
      await store.artifacts.referenceCounts([]),
    ],
  },
  {
    method: 'artifacts.projectsUsing',
    name: 'with names, attach order',
    fixture,
    run: async (store) => [
      await store.artifacts.projectsUsing([A.annLibrary, A.annUpload]),
      await store.artifacts.projectsUsing([]),
    ],
  },
  {
    method: 'artifacts.listOwned',
    name: 'newest first, ties by id',
    fixture,
    run: async (store) => [
      ids(await store.artifacts.listOwned(ANN)),
      await store.artifacts.listOwned('nobody'),
    ],
  },
  {
    method: 'artifacts.ocrSamples',
    name: 'finished runs, unfinished ones first as Postgres orders nulls',
    fixture,
    run: async (store) => [
      await store.artifacts.ocrSamples(10),
      await store.artifacts.ocrSamples(1),
    ],
  },
  {
    method: 'artifacts.libraryCount',
    name: 'kinds, project, words in names and digests',
    fixture,
    run: async (store) => [
      await store.artifacts.libraryCount(filter()),
      await store.artifacts.libraryCount(filter({ show: 'uploaded' })),
      await store.artifacts.libraryCount(filter({ show: 'generated' })),
      await store.artifacts.libraryCount(filter({ show: 'shared' })),
      await store.artifacts.libraryCount(filter({ show: 'shared', sharedIds: [] })),
      await store.artifacts.libraryCount(filter({ projectId: PROJECT.annChat })),
      await store.artifacts.libraryCount(filter({ query: 'invoice', terms: ['invoice'] })),
      await store.artifacts.libraryCount(filter({ query: 'budget', terms: ['budget'] })),
      await store.artifacts.libraryCount(filter({ query: 's_m', terms: ['s_m'] })),
      await store.artifacts.libraryCount(filter({ viewerSubject: 'nobody', sharedIds: [] })),
    ],
  },
  {
    method: 'artifacts.libraryRows',
    name: 'owned first, newest first, ties by id, paged',
    fixture,
    run: async (store) => [
      ids(await store.artifacts.libraryRows(filter(), { limit: 10, offset: 0 })),
      ids(await store.artifacts.libraryRows(filter(), { limit: 2, offset: 2 })),
      ids(
        await store.artifacts.libraryRows(filter({ query: 'march', terms: ['march'] }), {
          limit: 10,
          offset: 0,
        })
      ),
      await store.artifacts.libraryRows(filter({ show: 'shared', sharedIds: [] }), {
        limit: 10,
        offset: 0,
      }),
    ],
  },
  {
    method: 'artifacts.libraryPosition',
    name: 'owned and shared focus; outside the filter is null',
    fixture,
    run: async (store) => [
      await store.artifacts.libraryPosition(filter(), A.annUpload),
      await store.artifacts.libraryPosition(filter(), A.annOcr),
      await store.artifacts.libraryPosition(filter(), A.bobShared),
      await store.artifacts.libraryPosition(filter(), A.bobPrivate),
      await store.artifacts.libraryPosition(filter({ show: 'generated' }), A.annUpload),
    ],
  },
  {
    method: 'artifacts.ownedTotals',
    name: 'count and bytes; none',
    fixture,
    run: async (store) => [
      await store.artifacts.ownedTotals(ANN),
      await store.artifacts.ownedTotals('nobody'),
    ],
  },
  {
    method: 'artifacts.countExisting',
    name: 'known ids',
    fixture,
    run: async (store) => [
      await store.artifacts.countExisting([A.annUpload, A.bobShared, uid(1)]),
      await store.artifacts.countExisting([]),
    ],
  },
];
