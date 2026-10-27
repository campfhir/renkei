import type { Scenario } from '../../domain';
import type { DataStore } from '../../types';
import type { ArtifactChatSelection, ArtifactRecord, LibraryFilter } from './types';
import { ANN, BOB, CAT, CHAT, PROJECT, at, chatWorld, uid } from '../chats/fixtures';

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
const page = { limit: 20, offset: 0 };

/** A write's now() is not compared: only that updated_at moved off the fixture's. */
const stamped = (record: ArtifactRecord | null) =>
  record ? { ...record, createdAt: null, updatedAt: record.updatedAt > at(1000) } : null;

const W = {
  ocrA: uid(1011),
  ocrB: uid(1012),
  ocrOld: uid(1013),
  ocrBob: uid(1014),
  sent: uid(1015),
  temp: uid(1016),
  digestPending: uid(1017),
  digestStale: uid(1018),
  digestFresh: uid(1019),
};

const writeFixture = {
  ...fixture,
  chat_messages: [
    { id: uid(1301), chat_id: CHAT.annA, role: 'user', kind: 'text', content: 'hi', seq: 1 },
  ],
  artifacts: [
    ...fixture.artifacts,
    artifact(W.ocrA, ANN, 9, { chat_id: CHAT.annA, extract_status: 'needs_ocr' }),
    artifact(W.ocrB, ANN, 9, {
      chat_id: CHAT.annA,
      extract_status: 'needs_ocr',
      extracted_text: 'b',
    }),
    artifact(W.ocrOld, ANN, 8, { chat_id: CHAT.annA, extract_status: 'needs_ocr' }),
    artifact(W.ocrBob, BOB, 8, { chat_id: CHAT.annA, extract_status: 'needs_ocr' }),
    artifact(W.sent, ANN, 7, { chat_id: CHAT.annA, message_id: uid(1301) }),
    artifact(W.temp, ANN, 20, {
      blob_key: 'blob/replacement',
      filename: 'new.pdf',
      content_type: 'application/pdf',
      size_bytes: '777',
      extracted_text: 'sealed-replacement',
      extract_status: 'done',
      digest_status: 'pending',
    }),
    artifact(W.digestPending, ANN, 21, { digest_status: 'pending' }),
    artifact(W.digestStale, ANN, 22, { digest_status: 'running', updated_at: at(25) }),
    artifact(W.digestFresh, ANN, 23, { digest_status: 'running', updated_at: at(35) }),
  ],
  resource_access_grants: [
    ...(fixture.resource_access_grants ?? []),
    {
      id: uid(1401),
      resource_kind: 'artifact',
      resource_id: A.annLibrary,
      owner_subject: ANN,
      grantee_subject: BOB,
      role: 'viewer',
      created_at: at(3),
    },
    {
      id: uid(1402),
      resource_kind: 'artifact',
      resource_id: A.annLibrary,
      owner_subject: ANN,
      grantee_subject: CAT,
      role: 'viewer',
      created_at: at(4),
    },
    {
      id: uid(1403),
      resource_kind: 'artifact',
      resource_id: A.bobShared,
      owner_subject: BOB,
      grantee_subject: ANN,
      role: 'viewer',
      created_at: at(5),
    },
  ],
};

const selection = (overrides: Partial<ArtifactChatSelection> = {}): ArtifactChatSelection => ({
  ownerSubject: ANN,
  chatId: CHAT.annA,
  artifactIds: [W.ocrA, W.ocrB, W.ocrOld, W.ocrBob, W.sent, A.annUpload, A.annLibrary, uid(1)],
  ...overrides,
});

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
  {
    method: 'artifacts.listNeedingOcr',
    name: 'the owner’s needs_ocr rows of the chat and ids, oldest first, ties by id',
    fixture: writeFixture,
    run: async (store) => [
      ids(await store.artifacts.listNeedingOcr(selection())),
      ids(await store.artifacts.listNeedingOcr(selection({ ownerSubject: BOB }))),
      ids(await store.artifacts.listNeedingOcr(selection({ chatId: CHAT.annB }))),
      await store.artifacts.listNeedingOcr(selection({ artifactIds: [] })),
    ],
  },
  {
    method: 'artifacts.listUnsent',
    name: 'unsent rows of the selection with their text, oldest first, ties by id',
    fixture: writeFixture,
    run: async (store) => [
      (await store.artifacts.listUnsent(selection())).map((row) => [row.id, row.extractedText]),
      await store.artifacts.listUnsent(selection({ ownerSubject: CAT })),
      await store.artifacts.listUnsent(selection({ artifactIds: [] })),
    ],
  },
  {
    method: 'artifacts.create',
    name: 'inserted with its key and statuses; a duplicate id refused',
    fixture,
    run: async (store) => {
      const input = {
        id: uid(1201),
        ownerSubject: ANN,
        chatId: CHAT.annB,
        messageId: null,
        origin: 'model',
        keyKind: 'chat',
        keyRef: CHAT.annB,
        blobKey: 'blob/new',
        filename: 'new.txt',
        contentType: 'text/plain',
        sizeBytes: 12,
        extractedText: 'sealed-new',
        extractStatus: 'done',
        digestStatus: 'pending',
      };
      const created = await store.artifacts.create(input);
      const duplicate = await store.artifacts
        .create({ ...input, id: A.annUpload })
        .then(() => 'ok')
        .catch((error: { code?: string }) => error.code ?? 'error');
      return [
        stamped(created),
        stamped(await store.artifacts.get(uid(1201))),
        await store.artifacts.getText(uid(1201)),
        ids(await store.artifacts.listByChat(CHAT.annB)),
        duplicate,
      ];
    },
  },
  {
    method: 'artifacts.update',
    name: 'only the given fields, updated_at as given or now; missing row false',
    fixture,
    run: async (store) => [
      await store.artifacts.update(A.annUpload, {
        keyKind: 'artifact',
        keyRef: null,
        extractedText: 'resealed',
        updatedAt: at(50),
      }),
      await store.artifacts.get(A.annUpload),
      await store.artifacts.getText(A.annUpload),
      await store.artifacts.update(A.annOcr, {
        extractStatus: 'done',
        digestStatus: 'pending',
        ocrStartedAt: null,
        ocrFinishedAt: at(60),
        ocrMillis: 1234,
        ocrPages: 7,
        updatedAt: at(60),
      }),
      await store.artifacts.get(A.annOcr),
      await store.artifacts.update(A.annModel, { extractedText: null, ocrStartedAt: at(70) }),
      stamped(await store.artifacts.get(A.annModel)),
      await store.artifacts.getText(A.annModel),
      await store.artifacts.update(uid(1), { extractStatus: 'done' }),
      await store.artifacts.get(A.bobShared),
    ],
  },
  {
    method: 'artifacts.rename',
    name: 'the owner’s row only',
    fixture,
    run: async (store) => [
      await store.artifacts.rename({ artifactId: A.bobShared, ownerSubject: ANN, filename: 'x' }),
      await store.artifacts.rename({
        artifactId: A.annModel,
        ownerSubject: ANN,
        filename: 'y.png',
      }),
      await store.artifacts.rename({ artifactId: uid(1), ownerSubject: ANN, filename: 'z' }),
      (await store.artifacts.get(A.bobShared))?.filename,
      (await store.artifacts.get(A.annModel))?.filename,
    ],
  },
  {
    method: 'artifacts.delete',
    name: 'the row goes and its references with it; twice is false',
    fixture,
    run: async (store) => [
      await store.artifacts.delete(A.annLibrary),
      await store.artifacts.delete(A.annLibrary),
      await store.artifacts.get(A.annLibrary),
      await store.artifacts.listReferences(A.annLibrary),
      ids(await store.artifacts.listForProject(PROJECT.annChat)),
      await store.artifacts.countExisting([A.annUpload, A.bobShared]),
    ],
  },
  {
    method: 'artifacts.transferOwnership',
    name: 'new owner; their own share gone, the rest re-owned, other resources untouched',
    fixture: writeFixture,
    run: async (store) => {
      await store.artifacts.transferOwnership(A.annLibrary, BOB);
      const grants = (owner: string, id: string) =>
        store.resourceGrants
          .listForOwner(owner, 'artifact', id)
          .then((rows) => rows.map((row) => [row.id, row.granteeSubject]));
      return [
        (await store.artifacts.get(A.annLibrary))?.ownerSubject,
        await grants(BOB, A.annLibrary),
        await grants(ANN, A.annLibrary),
        await grants(BOB, A.bobShared),
        (await store.artifacts.get(A.annUpload))?.ownerSubject,
      ];
    },
  },
  {
    method: 'artifacts.adoptContent',
    name: 'the target takes the source’s content, loses its digest; the source goes',
    fixture: writeFixture,
    run: async (store) => [
      await store.artifacts.adoptContent(A.annLibrary, W.temp),
      stamped(await store.artifacts.get(A.annLibrary)),
      await store.artifacts.getText(A.annLibrary),
      await store.artifacts.get(W.temp),
      await store.artifacts.listReferences(A.annLibrary),
      await store.artifacts.libraryCount(filter({ terms: ['budget'], query: 'budget' })),
      await store.artifacts.adoptContent(A.annUpload, uid(1)),
      await store.artifacts.adoptContent(uid(1), A.annModel),
      (await store.artifacts.get(A.annModel))?.filename,
    ],
  },
  {
    method: 'artifacts.storeDigest',
    name: 'done with search terms, or failed',
    fixture,
    run: async (store) => {
      await store.artifacts.storeDigest(A.annModel, {
        summary: 'A bar chart of sales',
        keywords: ['chart', 'sales'],
      });
      await store.artifacts.storeDigest(A.annUpload, null);
      return [
        stamped(await store.artifacts.get(A.annModel)),
        stamped(await store.artifacts.get(A.annUpload)),
        ids(await store.artifacts.libraryRows(filter({ terms: ['sales'], query: 'sales' }), page)),
      ];
    },
  },
  {
    method: 'artifacts.copyDigest',
    name: 'summary and keywords as given, the source’s search terms',
    fixture,
    run: async (store) => {
      await store.artifacts.copyDigest({
        targetId: A.annModel,
        sourceId: A.annLibrary,
        summary: 'Quarterly budget review',
        keywords: ['finance'],
      });
      await store.artifacts.copyDigest({
        targetId: A.annOcr,
        sourceId: A.annUpload,
        summary: 'no terms',
        keywords: [],
      });
      return [
        await store.artifacts.get(A.annModel),
        await store.artifacts.get(A.annOcr),
        ids(
          await store.artifacts.libraryRows(filter({ terms: ['budget'], query: 'budget' }), page)
        ),
        ids(await store.artifacts.libraryRows(filter({ terms: ['terms'], query: 'terms' }), page)),
      ];
    },
  },
  {
    method: 'artifacts.claimDigest',
    name: 'pending, or running gone stale; once',
    fixture: writeFixture,
    run: async (store) => [
      await store.artifacts.claimDigest(W.digestPending, at(30)),
      await store.artifacts.claimDigest(W.digestPending, at(30)),
      await store.artifacts.claimDigest(W.digestStale, at(30)),
      await store.artifacts.claimDigest(W.digestFresh, at(30)),
      await store.artifacts.claimDigest(A.annLibrary, at(30)),
      await store.artifacts.claimDigest(uid(1), at(30)),
      (await store.artifacts.getMany([W.digestPending, W.digestStale, W.digestFresh])).map(
        (row) => row.digestStatus
      ),
    ],
  },
  {
    method: 'artifacts.claimOcr',
    name: 'none in flight, or a stale one; once',
    fixture,
    run: async (store) => [
      await store.artifacts.claimOcr(A.annModel, at(100), at(85)),
      await store.artifacts.claimOcr(A.annModel, at(101), at(86)),
      await store.artifacts.claimOcr(A.annOcr, at(100), at(85)),
      await store.artifacts.claimOcr(A.annOcr, at(100), at(7)),
      await store.artifacts.claimOcr(uid(1), at(100), at(85)),
      await store.artifacts.get(A.annModel),
      (await store.artifacts.get(A.annOcr))?.ocrStartedAt,
    ],
  },
  {
    method: 'artifacts.addReference',
    name: 'attached, or the mode reset in place keeping the row',
    fixture,
    run: async (store) => {
      const fresh = await store.artifacts.addReference({
        artifactId: A.annModel,
        projectId: PROJECT.annChat,
        mode: 'always',
        addedBy: ANN,
      });
      const again = await store.artifacts.addReference({
        artifactId: A.annLibrary,
        projectId: PROJECT.annChat,
        mode: 'on_demand',
        addedBy: BOB,
      });
      return [
        typeof fresh === 'string' && fresh.length === 36,
        again,
        (await store.artifacts.listReferences(A.annModel)).map((r) => [r.projectId, r.mode]),
        await store.artifacts.listReferences(A.annLibrary),
      ];
    },
  },
  {
    method: 'artifacts.setReferenceMode',
    name: 'held: changed; not held: false',
    fixture,
    run: async (store) => [
      await store.artifacts.setReferenceMode({
        artifactId: A.annUpload,
        projectId: PROJECT.annChat,
        mode: 'always',
      }),
      await store.artifacts.setReferenceMode({
        artifactId: A.annUpload,
        projectId: PROJECT.bobChat,
        mode: 'always',
      }),
      await store.artifacts.listForProject(PROJECT.annChat),
    ],
  },
  {
    method: 'artifacts.removeReference',
    name: 'detached once; the artifact stays',
    fixture,
    run: async (store) => [
      await store.artifacts.removeReference({
        artifactId: A.annLibrary,
        projectId: PROJECT.bobChat,
      }),
      await store.artifacts.removeReference({
        artifactId: A.annLibrary,
        projectId: PROJECT.bobChat,
      }),
      await store.artifacts.listReferences(A.annLibrary),
      (await store.artifacts.get(A.annLibrary))?.id,
    ],
  },
  {
    method: 'artifacts.listBlobsInChats',
    name: 'attachments of the listed chats only, by id; none for an empty list',
    fixture,
    run: async (store) => [
      await store.artifacts.listBlobsInChats([CHAT.annA, CHAT.bobShared]),
      await store.artifacts.listBlobsInChats([CHAT.catPrivate]),
      await store.artifacts.listBlobsInChats([]),
    ],
  },
];
