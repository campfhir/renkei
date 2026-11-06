import type { Scenario } from '../../domain';
import type { DataStore } from '../../types';
import { ANN, CHAT, at, chatWorld, uid } from '../chats/fixtures';

function task(
  n: number,
  chatId: string,
  number: number,
  values: Partial<{
    parent_id: string | null;
    status: string;
    depends_on: string[];
    started_at: Date | null;
    finished_at: Date | null;
  }> = {}
) {
  return {
    id: uid(870 + n),
    chat_id: chatId,
    parent_id: null,
    number,
    title: `sealed-title-${n}`,
    detail: n === 1 ? 'sealed-detail' : null,
    status: 'pending',
    progress: n === 2 ? 40 : null,
    progress_note: n === 2 ? 'sealed-note' : null,
    result: null,
    depends_on: [],
    created_by: 'assistant',
    created_at: at(n),
    updated_at: at(n),
    started_at: null,
    finished_at: null,
    ...values,
  };
}

const fixture = {
  ...chatWorld(),
  chat_tasks: [
    task(1, CHAT.annA, 1),
    task(2, CHAT.annA, 2, { status: 'in_progress', started_at: at(5) }),
    task(3, CHAT.annA, 3, { parent_id: uid(871), depends_on: [uid(872)] }),
    task(4, CHAT.annA, 4, { parent_id: uid(873) }),
    task(5, CHAT.annA, 5, { depends_on: [uid(871), uid(872)] }),
    task(6, CHAT.annB, 1),
  ],
  chat_task_waits: [
    {
      chat_id: CHAT.annA,
      task_ids: [uid(872)],
      events: ['completed', 'failed'],
      mode: 'all',
      deadline_at: at(30),
      subject: ANN,
      roles: ['user'],
      created_at: at(6),
    },
    {
      chat_id: CHAT.annB,
      task_ids: [uid(876)],
      events: ['completed'],
      mode: 'any',
      deadline_at: at(20),
      subject: ANN,
      roles: [],
      created_at: at(6),
    },
  ],
};

const numbersOf = (rows: { number: number; title: string }[]) =>
  rows.map((row) => [row.number, row.title]);
/** A record without the time the store itself stamps. */
const settled = <T extends { updatedAt: Date }>(row: T | null) => {
  if (!row) return null;
  const { updatedAt: _updatedAt, ...rest } = row;
  return rest;
};

export const chatTaskScenarios: Scenario<DataStore>[] = [
  {
    method: 'chatTasks.list',
    name: 'a chat’s tasks by number, its own only',
    fixture,
    run: async (store) => [
      await store.chatTasks.list(CHAT.annA),
      numbersOf(await store.chatTasks.list(CHAT.annB)),
      await store.chatTasks.list(CHAT.annEmpty),
    ],
  },
  {
    method: 'chatTasks.get',
    name: 'one task, only through its own chat',
    fixture,
    run: async (store) => [
      await store.chatTasks.get(CHAT.annA, uid(872)),
      await store.chatTasks.get(CHAT.annB, uid(872)),
      await store.chatTasks.get(CHAT.annA, uid(899)),
    ],
  },
  {
    method: 'chatTasks.create',
    name: 'numbered one past the chat’s highest, first in a chat is 1',
    fixture,
    run: async (store) => {
      const made = await store.chatTasks.create({
        chatId: CHAT.annA,
        parentId: uid(871),
        title: 'new',
        detail: null,
        status: 'in_progress',
        dependsOn: [uid(872)],
        createdBy: 'subagent',
        startedAt: at(9),
      });
      const first = await store.chatTasks.create({
        chatId: CHAT.annEmpty,
        parentId: null,
        title: 'first',
        detail: 'why',
        status: 'pending',
        dependsOn: [],
        createdBy: 'person',
        startedAt: null,
      });
      const shape = (row: typeof made) => [
        row.chatId,
        row.parentId,
        row.number,
        row.title,
        row.detail,
        row.status,
        row.progress,
        row.dependsOn,
        row.createdBy,
        row.startedAt,
        row.finishedAt,
      ];
      return {
        made: shape(made),
        first: shape(first),
        listed: numbersOf(await store.chatTasks.list(CHAT.annA)),
      };
    },
  },
  {
    method: 'chatTasks.update',
    name: 'sets only what is given, own chat only',
    fixture,
    run: async (store) => [
      settled(
        await store.chatTasks.update(CHAT.annA, uid(872), {
          status: 'completed',
          progress: 100,
          progressNote: null,
          result: 'sealed-result',
          finishedAt: at(12),
        })
      ),
      settled(
        await store.chatTasks.update(CHAT.annA, uid(871), {
          title: 'renamed',
          detail: null,
          dependsOn: [uid(875)],
          status: 'in_progress',
          startedAt: at(13),
        })
      ),
      await store.chatTasks.update(CHAT.annB, uid(871), { title: 'stolen' }),
      settled(await store.chatTasks.get(CHAT.annA, uid(873))),
    ],
  },
  {
    method: 'chatTasks.delete',
    name: 'takes the subtree and strips the ids from dependencies',
    fixture,
    run: async (store) => [
      await store.chatTasks.delete(CHAT.annA, []),
      await store.chatTasks.delete(CHAT.annB, [uid(871)]),
      await store.chatTasks.delete(CHAT.annA, [uid(871)]),
      (await store.chatTasks.list(CHAT.annA)).map((row) => [row.number, row.dependsOn]),
      numbersOf(await store.chatTasks.list(CHAT.annB)),
    ],
  },
  {
    method: 'chatTasks.getWait',
    name: 'the chat’s wait, or null',
    fixture,
    run: async (store) => [
      await store.chatTasks.getWait(CHAT.annA),
      await store.chatTasks.getWait(CHAT.annEmpty),
    ],
  },
  {
    method: 'chatTasks.putWait',
    name: 'adds a wait, or replaces the chat’s one',
    fixture,
    run: async (store) => {
      const shape = (wait: Awaited<ReturnType<DataStore['chatTasks']['putWait']>>) => [
        wait.chatId,
        wait.taskIds,
        wait.events,
        wait.mode,
        wait.deadlineAt,
        wait.subject,
        wait.roles,
      ];
      const replaced = await store.chatTasks.putWait({
        chatId: CHAT.annA,
        taskIds: [uid(871), uid(875)],
        events: ['cancelled'],
        mode: 'any',
        deadlineAt: null,
        subject: ANN,
        roles: ['admin', 'user'],
      });
      const added = await store.chatTasks.putWait({
        chatId: CHAT.annEmpty,
        taskIds: [],
        events: ['completed', 'failed', 'cancelled'],
        mode: 'all',
        deadlineAt: at(40),
        subject: ANN,
        roles: [],
      });
      return {
        replaced: shape(replaced),
        added: shape(added),
        reread: (await store.chatTasks.listDueWaits(at(60), 10)).map((w) => w.chatId),
      };
    },
  },
  {
    method: 'chatTasks.clearWait',
    name: 'only the first clear wins',
    fixture,
    run: async (store) => [
      await store.chatTasks.clearWait(CHAT.annA),
      await store.chatTasks.clearWait(CHAT.annA),
      await store.chatTasks.getWait(CHAT.annA),
      (await store.chatTasks.getWait(CHAT.annB))?.chatId ?? null,
    ],
  },
  {
    method: 'chatTasks.listDueWaits',
    name: 'deadline passed, earliest first, bounded',
    fixture,
    run: async (store) => [
      (await store.chatTasks.listDueWaits(at(10), 10)).map((w) => w.chatId),
      (await store.chatTasks.listDueWaits(at(20), 10)).map((w) => w.chatId),
      (await store.chatTasks.listDueWaits(at(60), 10)).map((w) => w.chatId),
      (await store.chatTasks.listDueWaits(at(60), 1)).map((w) => w.chatId),
    ],
  },
];
