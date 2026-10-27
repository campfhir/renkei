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
    model(uid(1400), 'beta', { settings: JSON.stringify({ contextWindow: 1000 }) }),
    model(uid(1401), 'Alpha', { provider: 'openai' }),
    model(uid(1402), 'Default', { is_default: true }),
    model(uid(1403), 'Off', { enabled: false }),
    model(uid(1404), 'Images', { settings: JSON.stringify({ apiSurface: 'images' }) }),
    model(uid(1405), 'Flux', { settings: JSON.stringify({ apiSurface: 'flux' }) }),
    model(uid(1406), 'Chat surface', { settings: JSON.stringify({ apiSurface: 'chat' }) }),
    model(uid(1407), 'Images off', {
      enabled: false,
      settings: JSON.stringify({ apiSurface: 'images' }),
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
