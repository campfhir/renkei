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
import { sql, type Kysely } from 'kysely';
import { encrypt, parseEncryptionKey } from '@renkei/crypto';
import { invalidateLlmCache, resolveAgentLlm, resolveImageModel } from '@renkei/agent-llm';
import { closeDatabase, getDatabase, type DB } from '@renkei/db';
import { listChatModels, listImageModels } from './models';

const maybe = process.env.DATABASE_URL ? describe : describe.skip;

maybe('image generation models', () => {
  let db: Kysely<DB>;
  const tenantId = randomUUID();
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
    settings: object;
    enabled?: boolean;
    isDefault?: boolean;
  }) {
    await db
      .insertInto('llm_model_configs')
      .values({
        id: values.id,
        label: values.label,
        provider: values.provider,
        model: values.model,
        base_url: null,
        settings: JSON.stringify(values.settings),
        encrypted_secrets: sealed(),
        enabled: values.enabled ?? true,
        is_default: values.isDefault ?? false,
      })
      .execute();
  }

  beforeAll(async () => {
    process.env.TOKEN_ENCRYPTION_KEY ||= randomBytes(32).toString('base64');
    const result = getDatabase();
    if (!result.ok) throw new Error('no database');
    db = result.val;
    await db
      .insertInto('tenants')
      .values({ id: tenantId, slug: `images-${tenantId.slice(0, 8)}` })
      .execute();
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
    invalidateLlmCache(tenantId);
  });

  afterAll(async () => {
    await sql`DELETE FROM llm_model_configs`.execute(db);
    await sql`DELETE FROM tenants WHERE id = ${tenantId}`.execute(db);
    await closeDatabase();
    if (previousKey === undefined) delete process.env.TOKEN_ENCRYPTION_KEY;
    else process.env.TOKEN_ENCRYPTION_KEY = previousKey;
  });

  it('keeps image models out of the chat picker, and chat models out of the image list', async () => {
    const chat = await listChatModels(db, tenantId);
    expect(chat.map((model) => model.label).sort()).toEqual(['Chatty', 'Claude']);
    const images = await listImageModels(db, tenantId);
    // The disabled one is not offered either.
    expect(images).toEqual([
      { id: fluxId, label: 'Fox', model: 'FLUX.2-flex' },
      { id: imageId, label: 'Painter', model: 'gpt-image-1' },
    ]);
  });

  it('never resolves an image model as a chat model, by id or as the default', async () => {
    for (const imageModel of [imageId, fluxId]) {
      const byId = await resolveAgentLlm(db, tenantId, imageModel);
      // An override that is not a chat model falls back to the org default.
      expect(byId.ok && byId.val.modelConfigId).toBe(chatId);
    }
    const fallback = await resolveAgentLlm(db, tenantId, null);
    expect(fallback.ok && fallback.val.modelConfigId).toBe(chatId);
  });

  it('resolves an image model with its key, and only an enabled image model', async () => {
    // The first by label is the FLUX row, and its surface travels with it.
    const first = await resolveImageModel(db, tenantId, null);
    expect(first.ok && first.val).toMatchObject({
      modelConfigId: fluxId,
      label: 'Fox',
      config: { apiKey: 'sk-test', model: 'FLUX.2-flex', surface: 'flux' },
    });
    const named = await resolveImageModel(db, tenantId, imageId);
    expect(named.ok && named.val).toMatchObject({
      modelConfigId: imageId,
      config: { model: 'gpt-image-1', surface: 'images' },
    });

    for (const notAnImageModel of [chatId, anthropicId, offImageId]) {
      const refused = await resolveImageModel(db, tenantId, notAnImageModel);
      expect(!refused.ok && refused.err.type).toBe('NO_MODEL');
    }
  });

  it('has no image model to resolve for an org that has none', async () => {
    const result = await resolveImageModel(db, randomUUID(), null);
    expect(!result.ok && result.err.type).toBe('NO_MODEL');
  });
});
