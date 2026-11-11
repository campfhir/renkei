import type { Scenario } from '../../domain';
import type { DataStore } from '../../types';

const id = (n: number) => `00000000-0000-4000-8000-11${String(n).padStart(10, '0')}`;

const row = (n: number, label: string, isDefault = false) => ({
  id: id(n),
  label,
  provider: 'anthropic',
  model: `model-${n}`,
  base_url: n === 2 ? 'https://proxy.example.test' : null,
  settings: n === 1 ? { maxTokens: 1000, tags: ['a'] } : {},
  encrypted_secrets: `sealed-${n}`,
  enabled: n !== 3,
  is_default: isDefault,
  created_at: new Date('2026-01-01T00:00:00.000Z'),
  updated_at: new Date('2026-01-01T00:00:00.000Z'),
});

const fixture = {
  llm_model_configs: [row(1, 'sonnet', true), row(2, 'haiku'), row(3, 'opus-old'), row(4, 'opus')],
};

const surfaceFixture = {
  llm_model_configs: [
    row(1, 'sonnet', true),
    row(2, 'haiku'),
    row(3, 'opus-old'),
    { ...row(5, 'painter'), settings: { apiSurface: 'images' } },
    { ...row(6, 'flux model'), settings: { apiSurface: 'flux' } },
    { ...row(7, 'Off image'), settings: { apiSurface: 'images' }, enabled: false },
    { ...row(8, 'responses'), settings: { apiSurface: 'responses' } },
  ],
};

const chat = (n: number, owner: string, model: number | null) => ({
  id: id(100 + n),
  owner_subject: owner,
  llm_model_id: model === null ? null : id(model),
  created_at: new Date('2026-01-01T00:00:00.000Z'),
  updated_at: new Date('2026-01-01T00:00:00.000Z'),
});

const agent = (n: number, owner: string, model: number | null) => ({
  id: id(200 + n),
  owner_subject: owner,
  name: `agent ${n}`,
  instructions: 'do',
  tools: [],
  llm_model_id: model === null ? null : id(model),
  created_at: new Date('2026-01-01T00:00:00.000Z'),
  updated_at: new Date('2026-01-01T00:00:00.000Z'),
});

const project = (n: number, owner: string, model: number | null) => ({
  id: id(300 + n),
  owner_subject: owner,
  name: `project ${n}`,
  llm_model_id: model === null ? null : id(model),
  created_at: new Date('2026-01-01T00:00:00.000Z'),
  updated_at: new Date('2026-01-01T00:00:00.000Z'),
});

/** ann: a project, two chats and an agent on haiku; bob: an agent; cat: a chat; eve: a project; dan: elsewhere. */
const usedFixture = {
  ...fixture,
  chat_projects: [project(1, 'ann', 2), project(2, 'eve', 2), project(3, 'dan', 1)],
  chats: [
    chat(1, 'ann', 2),
    chat(2, 'ann', 2),
    chat(3, 'cat', 2),
    chat(4, 'dan', 1),
    chat(5, 'dan', null),
  ],
  agents: [agent(1, 'ann', 2), agent(2, 'bob', 2), agent(3, 'dan', 4)],
};

/** Which model each project, chat and agent names, by id. */
const pointers = async (store: DataStore) => [
  await Promise.all(
    usedFixture.chat_projects.map(
      async (row) => (await store.chatProjects.get(row.id))?.llmModelId ?? null
    )
  ),
  await Promise.all(
    usedFixture.chats.map(async (row) => (await store.chats.get(row.id))?.llmModelId ?? null)
  ),
  await Promise.all(
    usedFixture.agents.map(async (row) => (await store.agents.find(row.id))?.llmModelId ?? null)
  ),
];

const input = (label: string, isDefault: boolean) => ({
  label,
  provider: 'openai',
  model: 'gpt-x',
  baseUrl: null,
  settings: { temperature: 0.5 },
  encryptedSecrets: 'sealed-new',
  enabled: true,
  isDefault,
});

const shape = async (store: DataStore) =>
  (await store.llmModels.list()).map((m) => [m.label, m.isDefault, m.model]);

export const llmModelScenarios: Scenario<DataStore>[] = [
  {
    method: 'llmModels.list',
    name: 'by label under collation, settings round-tripped',
    fixture,
    run: (store) => store.llmModels.list(),
  },
  {
    method: 'llmModels.get',
    name: 'one by id, an upper-cased id, and a stranger',
    fixture,
    run: async (store) => [
      await store.llmModels.get(id(2)),
      (await store.llmModels.get(id(2).toUpperCase()))?.label,
      await store.llmModels.get(id(9)),
    ],
  },
  {
    method: 'llmModels.create',
    name: 'a new default takes over; a taken label changes nothing',
    fixture,
    run: async (store) => [
      await store.llmModels.create(id(5), input('GPT', true)),
      await shape(store),
      await store.llmModels.create(id(6), input('haiku', true)),
      await shape(store),
      await store.llmModels.create(id(7), input('other', false)),
      await shape(store),
    ],
  },
  {
    method: 'llmModels.update',
    name: 'replaces fields, moves the default, refuses a taken label, misses a stranger',
    fixture,
    run: async (store) => [
      await store.llmModels.update(id(2), input('haiku', true)),
      await shape(store),
      await store.llmModels.update(id(3), input('sonnet', true)),
      await shape(store),
      await store.llmModels.update(id(9), input('nobody', true)),
      await shape(store),
      (await store.llmModels.get(id(2)))?.settings,
    ],
  },
  {
    method: 'llmModels.delete',
    name: 'deletes once',
    fixture,
    run: async (store) => [
      await store.llmModels.delete(id(1)),
      await store.llmModels.delete(id(1)),
      await shape(store),
    ],
  },
  {
    method: 'llmModels.delete',
    name: 'projects, chats and agents on it move to the replacement, or to no model without one',
    fixture: usedFixture,
    run: async (store) => [
      await store.llmModels.delete(id(2), id(4)),
      await pointers(store),
      await store.llmModels.delete(id(4)),
      await pointers(store),
      await store.llmModels.delete(id(9), id(1)),
      await pointers(store),
    ],
  },
  {
    method: 'llmModels.usedBy',
    name: 'each owner with their projects, chats and agents on it, by subject; nobody for an unused one',
    fixture: usedFixture,
    run: async (store) => [
      await store.llmModels.usedBy(id(2)),
      await store.llmModels.usedBy(id(4)),
      await store.llmModels.usedBy(id(3)),
    ],
  },
  {
    method: 'llmModels.findEnabledChatModel',
    name: 'by id or the default; disabled and image models never answer',
    fixture: surfaceFixture,
    run: async (store) =>
      Promise.all(
        [null, id(1), id(2), id(3), id(5), id(9)].map(
          async (key) => (await store.llmModels.findEnabledChatModel(key))?.label ?? null
        )
      ),
  },
  {
    method: 'llmModels.findEnabledImageModel',
    name: 'by id or the first by label; chat models never answer',
    fixture: surfaceFixture,
    run: async (store) => [
      (await store.llmModels.findEnabledImageModel(null))?.label ?? null,
      (await store.llmModels.findEnabledImageModel(id(6)))?.label ?? null,
      (await store.llmModels.findEnabledImageModel(id(1)))?.label ?? null,
      (await store.llmModels.findEnabledImageModel(id(7)))?.label ?? null,
      await store.llmModels.findEnabledImageModel(id(5)),
    ],
  },
];
