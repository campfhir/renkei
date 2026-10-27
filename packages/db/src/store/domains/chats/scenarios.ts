import type { Scenario } from '../../domain';
import type { DataStore } from '../../types';
import { ANN, BOB, CAT, CHAT, PROJECT, at, chatWorld, uid } from './fixtures';

const fixture = chatWorld();
const ids = (rows: { id: string }[]) => rows.map((row) => row.id);
/** What a write leaves behind, without the timestamps it set to now. */
const settled = (chat: { title: string | null; projectId: string | null } | null) =>
  chat && {
    title: chat.title,
    projectId: chat.projectId,
    ...('archivedAt' in chat ? { archived: chat.archivedAt !== null } : {}),
    ...('toolConfig' in chat ? { toolConfig: chat.toolConfig } : {}),
    ...('llmModelId' in chat ? { llmModelId: chat.llmModelId } : {}),
    ...('autoMode' in chat ? { autoMode: chat.autoMode } : {}),
    ...('thinkingEnabled' in chat ? { thinkingEnabled: chat.thinkingEnabled } : {}),
    ...('workspaceId' in chat ? { workspaceId: chat.workspaceId } : {}),
  };

export const chatScenarios: Scenario<DataStore>[] = [
  {
    method: 'chats.get',
    name: 'whole record, JSON parsed; missing is null',
    fixture,
    run: async (store) => [
      await store.chats.get(CHAT.annB),
      await store.chats.get(CHAT.annCode),
      await store.chats.get(uid(999)),
    ],
  },
  {
    method: 'chats.listOwned',
    name: 'newest first with id ties, archived, windows and limit',
    fixture,
    run: async (store) => [
      ids(await store.chats.listOwned(ANN, { limit: 50 })),
      ids(await store.chats.listOwned(ANN, { limit: 50, includeArchived: true })),
      ids(await store.chats.listOwned(ANN, { limit: 2, includeArchived: true })),
      ids(await store.chats.listOwned(ANN, { limit: 50, since: at(20), includeArchived: true })),
      ids(await store.chats.listOwned(ANN, { limit: 50, before: at(20), includeArchived: true })),
      await store.chats.listOwned('nobody', { limit: 5 }),
    ],
  },
  {
    method: 'chats.hasOwnedBefore',
    name: 'only chats with a message count',
    fixture,
    run: async (store) => [
      await store.chats.hasOwnedBefore(ANN, at(8)),
      await store.chats.hasOwnedBefore(ANN, at(7)),
      await store.chats.hasOwnedBefore(ANN, at(40)),
      await store.chats.hasOwnedBefore(CAT, at(16)),
    ],
  },
  {
    method: 'chats.listInProjects',
    name: 'unarchived, excluding an owner, bounded',
    fixture,
    run: async (store) => [
      ids(
        await store.chats.listInProjects([PROJECT.annChat, PROJECT.annCode], {
          excludeOwner: null,
          limit: 50,
        })
      ),
      ids(await store.chats.listInProjects([PROJECT.annChat], { excludeOwner: ANN, limit: 50 })),
      ids(
        await store.chats.listInProjects([PROJECT.annChat], {
          excludeOwner: null,
          since: at(13),
          limit: 50,
        })
      ),
      ids(await store.chats.listInProjects([PROJECT.annChat], { excludeOwner: null, limit: 1 })),
      await store.chats.listInProjects([], { excludeOwner: null, limit: 5 }),
    ],
  },
  {
    method: 'chats.listByIds',
    name: 'known ids only, newest first',
    fixture,
    run: async (store) => [
      ids(await store.chats.listByIds([CHAT.catPrivate, CHAT.annA, uid(999), CHAT.annB])),
      await store.chats.listByIds([]),
    ],
  },
  {
    method: 'chats.create',
    name: 'defaults and given fields; a missing project is refused',
    fixture,
    run: async (store) => {
      const id = await store.chats.create({
        ownerSubject: CAT,
        projectId: PROJECT.bobChat,
        llmModelId: null,
        toolConfig: { connectors: ['jira'] },
        thinkingEnabled: true,
        autoMode: true,
      });
      const chat = await store.chats.get(id);
      const refused = await store.chats
        .create({
          ownerSubject: CAT,
          projectId: uid(999),
          llmModelId: null,
          toolConfig: null,
          thinkingEnabled: false,
          autoMode: false,
        })
        .then(
          () => 'accepted',
          (error: { code?: string }) => error.code
        );
      return {
        chat: chat && {
          ...settled(chat),
          owner: chat.ownerSubject,
          archived: chat.archivedAt,
          lastMessageAt: chat.lastMessageAt,
          autoTitleAsked: chat.autoTitleAsked,
        },
        refused,
        count: (await store.chats.listOwned(CAT, { limit: 10 })).length,
      };
    },
  },
  {
    method: 'chats.update',
    name: "owner's chat only; fields, archive and unarchive",
    fixture,
    run: async (store) => {
      const results = [
        await store.chats.update(BOB, CHAT.annA, { title: 'stolen' }),
        await store.chats.update(ANN, CHAT.annA, {
          title: 'renamed',
          toolConfig: null,
          autoMode: true,
          thinkingEnabled: true,
          archived: true,
        }),
        await store.chats.update(ANN, CHAT.annArchived, { archived: false, toolConfig: { a: 1 } }),
        await store.chats.update(ANN, uid(999), { title: 'x' }),
      ];
      return {
        results,
        a: settled(await store.chats.get(CHAT.annA)),
        archived: settled(await store.chats.get(CHAT.annArchived)),
      };
    },
  },
  {
    method: 'chats.move',
    name: 'into and out of projects; owner only',
    fixture,
    run: async (store) => [
      await store.chats.move(ANN, CHAT.annB, PROJECT.annChat),
      await store.chats.move(BOB, CHAT.annA, null),
      await store.chats.move(ANN, CHAT.annA, null),
      settled(await store.chats.get(CHAT.annB)),
      settled(await store.chats.get(CHAT.annA)),
    ],
  },
  {
    method: 'chats.delete',
    name: 'owner only; rows that hang off it go too',
    fixture: {
      ...fixture,
      chat_drafts: [{ chat_id: CHAT.annA, content: 'sealed' }],
    },
    run: async (store) => [
      await store.chats.delete(BOB, CHAT.annA),
      await store.chats.delete(ANN, CHAT.annA),
      await store.chats.get(CHAT.annA),
      await store.chatThreads.getDraft(CHAT.annA),
      await store.chats.delete(ANN, CHAT.annA),
    ],
  },
  {
    method: 'chats.touch',
    name: 'title only while missing, model when given',
    fixture,
    run: async (store) => {
      await store.chats.touch(CHAT.annB, { titleIfMissing: 'first words' });
      await store.chats.touch(CHAT.annA, { titleIfMissing: 'ignored', llmModelId: null });
      await store.chats.touch(CHAT.annEmpty, {});
      const [a, b, empty] = await Promise.all([
        store.chats.get(CHAT.annA),
        store.chats.get(CHAT.annB),
        store.chats.get(CHAT.annEmpty),
      ]);
      return [settled(a), settled(b), empty?.title, empty?.lastMessageAt !== null];
    },
  },
  {
    method: 'chats.claimAutoTitle',
    name: 'once per chat',
    fixture,
    run: async (store) => [
      await store.chats.claimAutoTitle(CHAT.annA),
      await store.chats.claimAutoTitle(CHAT.annA),
      await store.chats.claimAutoTitle(CHAT.annB),
      await store.chats.claimAutoTitle(uid(999)),
    ],
  },
  {
    method: 'chats.renameIfTitledAs',
    name: 'only while the title is as expected, null included',
    fixture,
    run: async (store) => [
      await store.chats.renameIfTitledAs(CHAT.annA, 'not it', 'x'),
      await store.chats.renameIfTitledAs(CHAT.annA, 'A', 'Alpha chat'),
      await store.chats.renameIfTitledAs(CHAT.annB, null, 'named'),
      await store.chats.renameIfTitledAs(CHAT.annB, null, 'again'),
      (await store.chats.get(CHAT.annA))?.title,
      (await store.chats.get(CHAT.annB))?.title,
    ],
  },
  {
    method: 'chats.getRequestOverhead',
    name: 'set, unset and missing',
    fixture,
    run: async (store) => [
      await store.chats.getRequestOverhead(CHAT.annA),
      await store.chats.getRequestOverhead(CHAT.annB),
      await store.chats.getRequestOverhead(uid(999)),
    ],
  },
  {
    method: 'chats.setRequestOverhead',
    name: 'read back',
    fixture,
    run: async (store) => {
      await store.chats.setRequestOverhead(CHAT.annB, 77);
      return store.chats.getRequestOverhead(CHAT.annB);
    },
  },
  {
    method: 'chats.setWorkspace',
    name: 'set and clear',
    fixture,
    run: async (store) => {
      await store.chats.setWorkspace(CHAT.annA, uid(903));
      const set = (await store.chats.get(CHAT.annA))?.workspaceId;
      await store.chats.setWorkspace(CHAT.annCode, null);
      return [set, (await store.chats.get(CHAT.annCode))?.workspaceId];
    },
  },
  {
    method: 'chats.listOwnedInProject',
    name: "the owner's unarchived chats in one project, newest first, limited",
    fixture: {
      ...fixture,
      chats: [
        ...(fixture.chats ?? []),
        {
          id: uid(250),
          owner_subject: ANN,
          project_id: PROJECT.annChat,
          created_at: at(1),
          updated_at: at(20),
        },
        {
          id: uid(251),
          owner_subject: ANN,
          project_id: PROJECT.annChat,
          archived_at: at(25),
          created_at: at(1),
          updated_at: at(25),
        },
      ],
    },
    run: async (store) => [
      ids(await store.chats.listOwnedInProject(ANN, PROJECT.annChat, 10)),
      ids(await store.chats.listOwnedInProject(ANN, PROJECT.annChat, 1)),
      ids(await store.chats.listOwnedInProject(BOB, PROJECT.annChat, 10)),
      ids(await store.chats.listOwnedInProject(CAT, PROJECT.annChat, 10)),
    ],
  },
  {
    method: 'chats.deleteAbandoned',
    name: 'never written in, old enough, holding nothing; ids sorted',
    fixture: {
      ...fixture,
      chats: [
        ...(fixture.chats ?? []),
        { id: uid(251), owner_subject: BOB, created_at: at(2), updated_at: at(2) },
        { id: uid(252), owner_subject: ANN, created_at: at(1), updated_at: at(1) },
        { id: uid(253), owner_subject: ANN, created_at: at(1), updated_at: at(1) },
        { id: uid(254), owner_subject: ANN, created_at: at(1), updated_at: at(1) },
        { id: uid(255), owner_subject: ANN, created_at: at(50), updated_at: at(50) },
      ],
      chat_messages: [
        { id: uid(261), chat_id: uid(253), role: 'user', kind: 'text', content: 'hi', seq: 1 },
      ],
      artifacts: [
        {
          id: uid(262),
          owner_subject: ANN,
          chat_id: uid(254),
          blob_key: 'b/262',
          filename: 'f.txt',
          content_type: 'text/plain',
          size_bytes: '1',
        },
      ],
    },
    run: async (store) => [
      await store.chats.deleteAbandoned(at(40)),
      await store.chats.deleteAbandoned(at(40)),
      ids(await store.chats.listOwned(ANN, { limit: 50, includeArchived: true })),
    ],
  },
  {
    method: 'chats.archiveIdle',
    name: "the owner's idle unarchived chats without a running turn",
    fixture: {
      ...fixture,
      chat_turns: [
        { id: uid(271), chat_id: CHAT.annCode, status: 'running' },
        { id: uid(272), chat_id: CHAT.annB, status: 'completed' },
      ],
    },
    run: async (store) => {
      const archived = await store.chats.archiveIdle(ANN, at(25));
      const again = await store.chats.archiveIdle(ANN, at(25));
      const none = await store.chats.archiveIdle(CAT, at(10));
      const state = await Promise.all(
        [CHAT.annA, CHAT.annB, CHAT.annCode, CHAT.annEmpty, CHAT.bobShared].map(async (id) => {
          const chat = await store.chats.get(id);
          return chat && [id, chat.archivedAt !== null];
        })
      );
      return [archived, again, none, state];
    },
  },
  {
    method: 'chats.listIdsUpdatedBefore',
    name: 'anyone’s, oldest first, ties by id, bounded',
    fixture,
    run: async (store) => [
      await store.chats.listIdsUpdatedBefore(at(20), 3),
      await store.chats.listIdsUpdatedBefore(at(21), 50),
      await store.chats.listIdsUpdatedBefore(at(0), 50),
    ],
  },
  {
    method: 'chats.deleteMany',
    name: 'the listed chats, whoever owns them; unknown ids and an empty list delete nothing',
    fixture,
    run: async (store) => [
      await store.chats.deleteMany([CHAT.annA, CHAT.bobShared, uid(999)]),
      await store.chats.deleteMany([]),
      ids(await store.chats.listOwned(ANN, { limit: 50, includeArchived: true })),
      ids(await store.chats.listOwned(BOB, { limit: 50, includeArchived: true })),
    ],
  },
];
