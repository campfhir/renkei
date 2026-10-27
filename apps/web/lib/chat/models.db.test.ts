/**
 * Image generation models against a real database (skipped without
 * DATABASE_URL): a row whose API surface is the Images API is an image model and ONLY
 * that — it never appears where a chat model is chosen (the picker, the
 * org default, an agent's override) and never resolves as one, while the
 * image tool's own lookups see image rows and nothing else. A chat model
 * is the reverse. This is what keeps a model that cannot chat from being
 * picked to answer one.
 */

import { randomBytes, randomUUID } from 'node:crypto';
import { encrypt, parseEncryptionKey } from '@renkei/crypto';
import { invalidateLlmCache, resolveAgentLlm, resolveImageModel } from '@renkei/agent-llm';
import { closeDataStore, getDataStore } from '@renkei/db';
import { listChatModels, listImageModels } from './models';

const maybe = process.env.DATABASE_URL ? describe : describe.skip;

maybe('image generation models', () => {
  const chatId = randomUUID();
  const imageId = randomUUID();
  const fluxId = randomUUID();
  const offImageId = randomUUID();
  const anthropicId = randomUUID();
  const previousKey = process.env.TOKEN_ENCRYPTION_KEY;

  function sealed(): string {
    const key = parseEncryptionKey(process.env.TOKEN_ENCRYPTION_KEY ?? '');
    if (!key.ok) throw new Error('no encryption key');
    return encrypt(JSON.stringify({ apiKey: 'sk-test' }), key.val);
  }

  async function addModel(values: {
    id: string;
    label: string;
    provider: string;
    model: string;
    settings: Record<string, unknown>;
    enabled?: boolean;
    isDefault?: boolean;
  }) {
    const created = await getDataStore().llmModels.create(values.id, {
      label: values.label,
      provider: values.provider,
      model: values.model,
      baseUrl: null,
      settings: values.settings,
      encryptedSecrets: sealed(),
      enabled: values.enabled ?? true,
      isDefault: values.isDefault ?? false,
    });
    if (created !== 'created') throw new Error(`${values.label}: ${created}`);
  }

  beforeAll(async () => {
    process.env.TOKEN_ENCRYPTION_KEY ||= randomBytes(32).toString('base64');
    // Labels are unique organization-wide, and a run that died before its
    // afterAll leaves this suite's rows behind under fresh ids: remove them
    // by label (these names are this suite's alone) before adding.
    const store = getDataStore();
    const labels = new Set(['Chatty', 'Painter', 'Fox', 'Retired painter', 'Claude']);
    for (const model of await store.llmModels.list()) {
      if (labels.has(model.label)) await store.llmModels.delete(model.id);
    }
    await addModel({
      id: chatId,
      label: 'Chatty',
      provider: 'openai',
      model: 'gpt-chat',
      settings: {},
      isDefault: true,
    });
    await addModel({
      id: imageId,
      label: 'Painter',
      provider: 'openai',
      model: 'gpt-image-1',
      settings: { apiSurface: 'images' },
    });
    await addModel({
      id: fluxId,
      label: 'Fox',
      provider: 'openai',
      model: 'FLUX.2-flex',
      settings: { apiSurface: 'flux' },
    });
    await addModel({
      id: offImageId,
      label: 'Retired painter',
      provider: 'openai',
      model: 'gpt-image-0',
      settings: { apiSurface: 'images' },
      enabled: false,
    });
    // An Anthropic chat model with no flag: never an image model.
    await addModel({
      id: anthropicId,
      label: 'Claude',
      provider: 'anthropic',
      model: 'claude-x',
      settings: {},
    });
    invalidateLlmCache();
  });

  afterAll(async () => {
    const store = getDataStore();
    for (const id of [chatId, imageId, fluxId, offImageId, anthropicId]) {
      await store.llmModels.delete(id);
    }
    await closeDataStore();
    if (previousKey === undefined) delete process.env.TOKEN_ENCRYPTION_KEY;
    else process.env.TOKEN_ENCRYPTION_KEY = previousKey;
  });

  it('keeps image models out of the chat picker, and chat models out of the image list', async () => {
    // Both lists are the organization's, so other suites' models in a shared
    // database sit beside these; only this suite's own are judged.
    const mine = new Set<string>([chatId, imageId, fluxId, offImageId, anthropicId]);
    const chat = (await listChatModels()).filter((model) => mine.has(model.id));
    expect(chat.map((model) => model.label).sort()).toEqual(['Chatty', 'Claude']);
    const images = (await listImageModels()).filter((model) => mine.has(model.id));
    // The disabled one is not offered either.
    expect(images).toEqual([
      { id: fluxId, label: 'Fox', model: 'FLUX.2-flex' },
      { id: imageId, label: 'Painter', model: 'gpt-image-1' },
    ]);
  });

  it('never resolves an image model as a chat model, by id or as the default', async () => {
    for (const imageModel of [imageId, fluxId]) {
      const byId = await resolveAgentLlm(imageModel);
      // An override that is not a chat model falls back to the org default.
      expect(byId.ok && byId.val.modelConfigId).toBe(chatId);
    }
    const fallback = await resolveAgentLlm(null);
    expect(fallback.ok && fallback.val.modelConfigId).toBe(chatId);
  });

  it('resolves an image model with its key, and only an enabled image model', async () => {
    // The first by label is the FLUX row, and its surface travels with it.
    const first = await resolveImageModel(null);
    expect(first.ok && first.val).toMatchObject({
      modelConfigId: fluxId,
      label: 'Fox',
      config: { apiKey: 'sk-test', model: 'FLUX.2-flex', surface: 'flux' },
    });
    const named = await resolveImageModel(imageId);
    expect(named.ok && named.val).toMatchObject({
      modelConfigId: imageId,
      config: { model: 'gpt-image-1', surface: 'images' },
    });

    for (const notAnImageModel of [chatId, anthropicId, offImageId]) {
      const refused = await resolveImageModel(notAnImageModel);
      expect(!refused.ok && refused.err.type).toBe('NO_MODEL');
    }
  });

  it('has no image model to resolve once the organization has none left on', async () => {
    // Switched off the way the admin page's edit does: everything else kept.
    const store = getDataStore();
    for (const id of [imageId, fluxId]) {
      const model = await store.llmModels.get(id);
      if (!model) throw new Error('no such model');
      const settings =
        typeof model.settings === 'object' && model.settings !== null
          ? Object.fromEntries(Object.entries(model.settings))
          : {};
      await store.llmModels.update(id, {
        label: model.label,
        provider: model.provider,
        model: model.model,
        baseUrl: model.baseUrl,
        settings,
        encryptedSecrets: model.encryptedSecrets,
        enabled: false,
        isDefault: model.isDefault,
      });
    }
    const result = await resolveImageModel(null);
    expect(!result.ok && result.err.type).toBe('NO_MODEL');
  });
});
