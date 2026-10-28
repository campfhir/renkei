import type { Scenario } from '../../domain';
import type { DataStore } from '../../types';
import { ANN, BOB, at, uid } from '../chats/fixtures';

const LIB = { ann: uid(401), ann2: uid(402), bob: uid(403) };

function prompt(n: number, libraryId: string, position: number, minute: number) {
  return {
    id: uid(450 + n),
    library_id: libraryId,
    title: `p${n}`,
    body: `body ${n}`,
    position,
    created_by_subject: ANN,
    updated_by_subject: ANN,
    created_at: at(minute),
    updated_at: at(minute),
  };
}

const fixture = {
  prompt_libraries: [
    { id: LIB.ann, owner_subject: ANN, name: 'Mine', created_at: at(1), updated_at: at(5) },
    {
      id: LIB.ann2,
      owner_subject: ANN,
      name: 'Two',
      description: 'd',
      created_at: at(2),
      updated_at: at(5),
    },
    { id: LIB.bob, owner_subject: BOB, name: 'Bob', created_at: at(3), updated_at: at(9) },
  ],
  prompts: [
    prompt(1, LIB.ann, 2, 1),
    prompt(2, LIB.ann, 1, 3),
    prompt(3, LIB.ann, 1, 2),
    prompt(4, LIB.bob, 1, 1),
    prompt(5, LIB.ann2, 7, 1),
  ],
};
const ids = (rows: { id: string }[]) => rows.map((row) => row.id);
const libraryState = async (store: DataStore, id: string) => {
  const library = await store.promptLibraries.get(id);
  return (
    library && {
      name: library.name,
      description: library.description,
      touched: library.updatedAt > at(10),
    }
  );
};

export const promptLibraryScenarios: Scenario<DataStore>[] = [
  {
    method: 'promptLibraries.get',
    name: 'found and missing',
    fixture,
    run: async (store) => [
      await store.promptLibraries.get(LIB.ann2),
      await store.promptLibraries.get(uid(999)),
    ],
  },
  {
    method: 'promptLibraries.listOwned',
    name: 'newest first with id ties',
    fixture,
    run: async (store) => [
      ids(await store.promptLibraries.listOwned(ANN)),
      await store.promptLibraries.listOwned('nobody'),
    ],
  },
  {
    method: 'promptLibraries.listByIds',
    name: 'known ids only',
    fixture,
    run: async (store) => [
      ids(await store.promptLibraries.listByIds([LIB.bob, LIB.ann, uid(999)])),
      await store.promptLibraries.listByIds([]),
    ],
  },
  {
    method: 'promptLibraries.create',
    name: 'read back',
    run: async (store) => {
      const id = await store.promptLibraries.create({
        ownerSubject: ANN,
        name: 'New',
        description: null,
      });
      const library = await store.promptLibraries.get(id);
      return library && [library.ownerSubject, library.name, library.description];
    },
  },
  {
    method: 'promptLibraries.update',
    name: 'fields and missing',
    fixture,
    run: async (store) => [
      await store.promptLibraries.update(LIB.ann, { name: 'Renamed', description: 'now' }),
      await store.promptLibraries.update(LIB.ann2, { description: null }),
      await store.promptLibraries.update(uid(999), { name: 'x' }),
      await libraryState(store, LIB.ann),
      await libraryState(store, LIB.ann2),
    ],
  },
  {
    method: 'promptLibraries.delete',
    name: 'owner only; prompts go with it',
    fixture,
    run: async (store) => [
      await store.promptLibraries.delete(BOB, LIB.ann),
      await store.promptLibraries.delete(ANN, LIB.ann),
      await store.promptLibraries.get(LIB.ann),
      await store.promptLibraries.listPrompts(LIB.ann),
    ],
  },
  {
    method: 'promptLibraries.listPrompts',
    name: 'position, then age',
    fixture,
    run: async (store) => [
      await store.promptLibraries.listPrompts(LIB.ann),
      await store.promptLibraries.listPrompts(uid(999)),
    ],
  },
  {
    method: 'promptLibraries.listPromptsIn',
    name: 'by library then position',
    fixture,
    run: async (store) => [
      ids(await store.promptLibraries.listPromptsIn([LIB.ann2, LIB.ann])),
      await store.promptLibraries.listPromptsIn([]),
    ],
  },
  {
    method: 'promptLibraries.createPrompt',
    name: 'after the last position, library bumped',
    fixture,
    run: async (store) => {
      await store.promptLibraries.createPrompt({
        libraryId: LIB.ann,
        title: 't',
        body: 'b',
        subject: BOB,
      });
      await store.promptLibraries.createPrompt({
        libraryId: LIB.ann,
        title: 't2',
        body: 'b2',
        subject: ANN,
      });
      const prompts = await store.promptLibraries.listPrompts(LIB.ann);
      return {
        prompts: prompts.map((p) => [p.title, p.position, p.createdBySubject]),
        touched: await libraryState(store, LIB.ann),
        untouched: await libraryState(store, LIB.bob),
      };
    },
  },
  {
    method: 'promptLibraries.updatePrompt',
    name: 'within its library only; library bumped',
    fixture,
    run: async (store) => {
      const results = [
        await store.promptLibraries.updatePrompt(LIB.bob, uid(451), { title: 'no' }, BOB),
        await store.promptLibraries.updatePrompt(
          LIB.ann,
          uid(451),
          { title: 'yes', body: 'new', position: 0 },
          BOB
        ),
      ];
      const prompts = await store.promptLibraries.listPrompts(LIB.ann);
      return {
        results,
        prompts: prompts.map((p) => [p.id, p.title, p.body, p.position, p.updatedBySubject]),
        library: await libraryState(store, LIB.ann),
        bob: await libraryState(store, LIB.bob),
      };
    },
  },
  {
    method: 'promptLibraries.deletePrompt',
    name: 'within its library only',
    fixture,
    run: async (store) => [
      await store.promptLibraries.deletePrompt(LIB.bob, uid(451)),
      await store.promptLibraries.deletePrompt(LIB.ann, uid(451)),
      ids(await store.promptLibraries.listPrompts(LIB.ann)),
      await libraryState(store, LIB.ann),
    ],
  },
];
