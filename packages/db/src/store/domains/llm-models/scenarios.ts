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
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
});

const fixture = {
  llm_model_configs: [row(1, 'Sonnet', true), row(2, 'haiku'), row(3, 'Opus'), row(4, 'opus')],
};

const surfaceFixture = {
  llm_model_configs: [
    row(1, 'Sonnet', true),
    row(2, 'haiku'),
    row(3, 'Opus'),
    { ...row(5, 'Painter'), settings: { apiSurface: 'images' } },
    { ...row(6, 'Flux'), settings: { apiSurface: 'flux' } },
    { ...row(7, 'Off image'), settings: { apiSurface: 'images' }, enabled: false },
    { ...row(8, 'Responses'), settings: { apiSurface: 'responses' } },
  ],
};

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
      await store.llmModels.create(id(7), input('Other', false)),
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
      await store.llmModels.update(id(3), input('Sonnet', true)),
      await shape(store),
      await store.llmModels.update(id(9), input('Nobody', true)),
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
