import type { Scenario } from '../../domain';
import type { DataStore } from '../../types';
import { uid } from '../chats/fixtures';

function model(id: string, label: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    label,
    provider: 'anthropic',
    model: `m-${id}`,
    encrypted_secrets: 'sealed',
    ...extra,
  };
}

const fixture = {
  llm_model_configs: [
    model(uid(1400), 'beta', { settings: { contextWindow: 1000 } }),
    model(uid(1401), 'alpha', { provider: 'openai' }),
    model(uid(1402), 'default', { is_default: true }),
    model(uid(1403), 'off', { enabled: false }),
    model(uid(1404), 'images', { settings: { apiSurface: 'images' } }),
    model(uid(1405), 'flux', { settings: { apiSurface: 'flux' } }),
    model(uid(1406), 'chat surface', { settings: { apiSurface: 'chat' } }),
    model(uid(1407), 'images off', {
      enabled: false,
      settings: { apiSurface: 'images' },
    }),
  ],
};

export const chatModelScenarios: Scenario<DataStore>[] = [
  {
    method: 'chatModels.listChatModels',
    name: 'enabled chat models, default first then label',
    fixture,
    run: async (store) => store.chatModels.listChatModels(),
  },
  {
    method: 'chatModels.listImageModels',
    name: 'enabled image models by label',
    fixture,
    run: async (store) => store.chatModels.listImageModels(),
  },
];
