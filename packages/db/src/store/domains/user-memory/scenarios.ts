import type { Scenario } from '../../domain';
import type { DataStore } from '../../types';
import { ANN, BOB, CHAT, at, chatWorld, uid } from '../chats/fixtures';

function memo(n: number, owner: string, minute: number, kind = 'entry') {
  return {
    id: uid(850 + n),
    owner_subject: owner,
    kind,
    content: `sealed-${n}`,
    chat_id: n === 1 ? CHAT.annA : null,
    created_at: at(minute),
    updated_at: at(minute),
  };
}

const fixture = {
  ...chatWorld(),
  chat_user_memories: [
    memo(1, ANN, 1),
    memo(2, ANN, 3),
    memo(3, ANN, 3),
    memo(4, ANN, 2, 'summary'),
    memo(5, BOB, 4),
  ],
};
const ids = (rows: { id: string }[]) => rows.map((row) => row.id);

export const userMemoryScenarios: Scenario<DataStore>[] = [
  {
    method: 'userMemory.list',
    name: 'newest first, ties by id, bounded, own only',
    fixture,
    run: async (store) => [
      await store.userMemory.list(ANN, 10),
      ids(await store.userMemory.list(ANN, 2)),
      await store.userMemory.list('nobody', 10),
    ],
  },
  {
    method: 'userMemory.append',
    name: 'appends and trims entries beyond keep, summary kept',
    fixture,
    run: async (store) => {
      await store.userMemory.append({ ownerSubject: ANN, content: 'new', chatId: null, keep: 2 });
      const rows = await store.userMemory.list(ANN, 10);
      return {
        rows: rows.map((r) => [r.kind, r.content]),
        bob: ids(await store.userMemory.list(BOB, 10)),
      };
    },
  },
  {
    method: 'userMemory.edit',
    name: 'own entries only, never the summary',
    fixture,
    run: async (store) => [
      await store.userMemory.edit(ANN, uid(851), 'edited'),
      await store.userMemory.edit(BOB, uid(852), 'stolen'),
      await store.userMemory.edit(ANN, uid(854), 'summary'),
      (await store.userMemory.list(ANN, 10)).map((r) => r.content),
    ],
  },
  {
    method: 'userMemory.forget',
    name: 'by id (own only) or all',
    fixture,
    run: async (store) => [
      await store.userMemory.forget(ANN, { kind: 'entries', ids: [] }),
      await store.userMemory.forget(ANN, { kind: 'entries', ids: [uid(851), uid(855)] }),
      ids(await store.userMemory.list(ANN, 10)),
      await store.userMemory.forget(ANN, { kind: 'all' }),
      ids(await store.userMemory.list(BOB, 10)),
    ],
  },
];
