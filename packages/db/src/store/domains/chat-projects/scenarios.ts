import type { Scenario } from '../../domain';
import type { DataStore } from '../../types';
import { ANN, BOB, CHAT, PROJECT, at, chatWorld, uid } from '../chats/fixtures';

function memo(n: number, projectId: string, minute: number, kind = 'entry') {
  return {
    id: uid(800 + n),
    project_id: projectId,
    kind,
    content: `sealed-${n}`,
    author_subject: n % 2 ? ANN : BOB,
    chat_id: n === 1 ? CHAT.annA : null,
    created_at: at(minute),
    updated_at: at(minute),
  };
}

const fixture = {
  ...chatWorld(),
  chat_project_memories: [
    memo(1, PROJECT.annChat, 1),
    memo(2, PROJECT.annChat, 3),
    memo(3, PROJECT.annChat, 3),
    memo(4, PROJECT.annChat, 2, 'summary'),
    memo(5, PROJECT.bobChat, 4),
  ],
};
const ids = (rows: { id: string }[]) => rows.map((row) => row.id);

export const chatProjectScenarios: Scenario<DataStore>[] = [
  {
    method: 'chatProjects.get',
    name: 'chat and code projects; missing',
    fixture,
    run: async (store) => [
      await store.chatProjects.get(PROJECT.annChat),
      await store.chatProjects.get(PROJECT.annCode),
      await store.chatProjects.get(uid(999)),
    ],
  },
  {
    method: 'chatProjects.listOwned',
    name: 'newest first with id ties',
    fixture,
    run: async (store) => [
      ids(await store.chatProjects.listOwned(ANN)),
      ids(await store.chatProjects.listOwned('nobody')),
    ],
  },
  {
    method: 'chatProjects.listByIds',
    name: 'by update or by name; unknown ids left out',
    fixture,
    run: async (store) => {
      const all = [PROJECT.bobChat, PROJECT.annCode, PROJECT.annChat, uid(999)];
      return [
        ids(await store.chatProjects.listByIds(all)),
        (await store.chatProjects.listByIds(all, { orderBy: 'name' })).map((p) => p.name),
        await store.chatProjects.listByIds([]),
      ];
    },
  },
  {
    method: 'chatProjects.withGrantCounts',
    name: 'unexpired grants counted, none is zero',
    fixture,
    run: async (store) => [
      await store.chatProjects.withGrantCounts([
        PROJECT.annChat,
        PROJECT.annCode,
        PROJECT.bobChat,
        uid(999),
      ]),
      await store.chatProjects.withGrantCounts([]),
    ],
  },
  {
    method: 'chatProjects.create',
    name: 'chat and code projects',
    run: async (store) => {
      const chat = await store.chatProjects.create({
        ownerSubject: ANN,
        name: 'n',
        description: null,
        toolConfig: { connectors: [] },
      });
      const code = await store.chatProjects.create({
        ownerSubject: ANN,
        name: 'c',
        description: 'd',
        toolConfig: null,
        repo: { provider: 'github', fullName: 'a/b', branch: null },
      });
      const shape = (p: Awaited<ReturnType<DataStore['chatProjects']['get']>>) =>
        p && {
          kind: p.kind,
          name: p.name,
          description: p.description,
          instructions: p.instructions,
          toolConfig: p.toolConfig,
          repo: [p.repoProvider, p.repoFullName, p.repoBranch],
          workspaceId: p.workspaceId,
        };
      return [shape(await store.chatProjects.get(chat)), shape(await store.chatProjects.get(code))];
    },
  },
  {
    method: 'chatProjects.update',
    name: 'fields set, others kept; missing is false',
    fixture,
    run: async (store) => {
      const results = [
        await store.chatProjects.update(PROJECT.annChat, {
          name: 'renamed',
          instructions: null,
          toolConfig: null,
        }),
        await store.chatProjects.update(PROJECT.annCode, {
          repo: { provider: 'github', fullName: 'acme/gamma', branch: null },
          workspaceId: null,
          instructions: 'sealed',
        }),
        await store.chatProjects.update(uid(999), { name: 'x' }),
      ];
      const [a, b] = await store.chatProjects.listByIds([PROJECT.annChat, PROJECT.annCode], {
        orderBy: 'name',
      });
      const strip = (p: typeof a) => p && { ...p, updatedAt: undefined };
      return { results, a: strip(a), b: strip(b) };
    },
  },
  {
    method: 'chatProjects.delete',
    name: 'owner only; memory goes, chats stay outside',
    fixture,
    run: async (store) => [
      await store.chatProjects.delete(BOB, PROJECT.annChat),
      await store.chatProjects.delete(ANN, PROJECT.annChat),
      await store.chatProjects.get(PROJECT.annChat),
      await store.chatProjects.listMemory(PROJECT.annChat, 10),
      (await store.chats.get(CHAT.annA))?.projectId,
    ],
  },
  {
    method: 'chatProjects.listMemory',
    name: 'newest first, ties by id, bounded',
    fixture,
    run: async (store) => [
      await store.chatProjects.listMemory(PROJECT.annChat, 10),
      ids(await store.chatProjects.listMemory(PROJECT.annChat, 2)),
      await store.chatProjects.listMemory(PROJECT.annCode, 10),
    ],
  },
  {
    method: 'chatProjects.appendMemory',
    name: 'appends and trims the oldest entries beyond keep',
    fixture,
    run: async (store) => {
      await store.chatProjects.appendMemory({
        projectId: PROJECT.annChat,
        content: 'sealed-new',
        authorSubject: ANN,
        chatId: CHAT.annA,
        keep: 2,
      });
      const rows = await store.chatProjects.listMemory(PROJECT.annChat, 10);
      return {
        rows: rows.map((r) => [r.kind, r.content, r.chatId]),
        bob: ids(await store.chatProjects.listMemory(PROJECT.bobChat, 10)),
      };
    },
  },
  {
    method: 'chatProjects.forgetMemory',
    name: 'by id within the project, or all',
    fixture,
    run: async (store) => [
      await store.chatProjects.forgetMemory(PROJECT.annChat, { kind: 'entries', ids: [] }),
      await store.chatProjects.forgetMemory(PROJECT.annChat, {
        kind: 'entries',
        ids: [uid(801), uid(805)],
      }),
      ids(await store.chatProjects.listMemory(PROJECT.annChat, 10)),
      await store.chatProjects.forgetMemory(PROJECT.annChat, { kind: 'all' }),
      ids(await store.chatProjects.listMemory(PROJECT.bobChat, 10)),
    ],
  },
];
