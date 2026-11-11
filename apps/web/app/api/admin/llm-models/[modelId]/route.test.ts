/**
 * The model roster's update path: a blank apiKey on save must keep the
 * stored secret (a settings-only edit must not wipe the key), a typed one
 * must replace it, and apiKeyFromId must borrow a sibling's blob — the
 * same three key-sourcing rules the create route follows, now on PUT.
 */

jest.mock('@/lib/access', () => ({
  checkAccess: jest.fn(),
  ROLE_OPERATOR: 'renkei-operator',
}));
jest.mock('@renkei/agent-llm', () => ({
  ...jest.requireActual('@renkei/agent-llm'),
  invalidateLlmCache: jest.fn(),
}));

import { NextRequest } from 'next/server';
import { randomBytes, randomUUID } from 'node:crypto';
import { decrypt, encrypt, parseEncryptionKey } from '@renkei/crypto';
import {
  createMemoryDataStore,
  getDataStore,
  registerDataStore,
  resetDataStore,
} from '@renkei/db';
import { getChatModelPrefs, patchChatModelPrefs } from '@renkei/user-prefs';
import { DELETE, PUT } from './route';
import { GET as USAGE } from './usage/route';

const { checkAccess: mockCheckAccess } = jest.requireMock<{ checkAccess: jest.Mock }>(
  '@/lib/access'
);

interface ModelConfigRow {
  id: string;
  label: string;
  provider: string;
  model: string;
  base_url: string | null;
  settings: Record<string, string>;
  /** '' for a row with no key stored. */
  encrypted_secrets: string;
  enabled: boolean;
  is_default: boolean;
}

const ROW_1 = '00000000-0000-4000-8000-000000000f01';
const ROW_2 = '00000000-0000-4000-8000-000000000f02';

/** A memory data store holding these model rows, `rows` read back in id order. */
function fakeDb(seed: ModelConfigRow[]) {
  const store = createMemoryDataStore();
  store.tables.seed({ llm_model_configs: seed });
  registerDataStore(store);
  return {
    get rows() {
      return store.tables.select('llm_model_configs').sort((a, b) => a.id.localeCompare(b.id));
    },
  };
}

const paramsOf = (modelId = ROW_1) => Promise.resolve({ modelId });
const ENCRYPTION_KEY = randomBytes(32).toString('base64');
const keyResult = parseEncryptionKey(ENCRYPTION_KEY);
if (!keyResult.ok) throw new Error('test setup: bad encryption key');
const KEY_BUFFER = keyResult.val;

function reqOf(body: unknown, method = 'PUT'): NextRequest {
  return new NextRequest(
    new Request('http://x/api/admin/acme/llm-models/row-1', { method, body: JSON.stringify(body) })
  );
}

const baseRow: ModelConfigRow = {
  id: ROW_1,
  label: 'Prod Claude',
  provider: 'anthropic',
  model: 'claude-sonnet-5',
  base_url: null,
  settings: {},
  encrypted_secrets: encrypt(JSON.stringify({ apiKey: 'original-secret' }), KEY_BUFFER),
  enabled: true,
  is_default: false,
};

afterAll(() => {
  resetDataStore();
});

beforeEach(() => {
  jest.clearAllMocks();
  mockCheckAccess.mockResolvedValue({ subject: 'auth0|alice' });
  process.env.TOKEN_ENCRYPTION_KEY = ENCRYPTION_KEY;
});

describe('PUT .../llm-models/[modelId]', () => {
  it('keeps the stored key when apiKey is blank', async () => {
    const db = fakeDb([{ ...baseRow }]);

    const response = await PUT(
      reqOf({ label: 'Prod Claude (renamed)', provider: 'anthropic', model: 'claude-sonnet-5' }),
      { params: paramsOf() }
    );

    expect(response.status).toBe(200);
    const stored = db.rows[0]!.encrypted_secrets;
    const decrypted = decrypt(stored, KEY_BUFFER);
    expect(decrypted.ok).toBe(true);
    if (decrypted.ok) expect(JSON.parse(decrypted.val)).toEqual({ apiKey: 'original-secret' });
  });

  it('replaces the key when a new one is typed', async () => {
    const db = fakeDb([{ ...baseRow }]);

    const response = await PUT(
      reqOf({
        label: 'Prod Claude',
        provider: 'anthropic',
        model: 'claude-sonnet-5',
        apiKey: 'rotated-secret',
      }),
      { params: paramsOf() }
    );

    expect(response.status).toBe(200);
    const decrypted = decrypt(db.rows[0]!.encrypted_secrets, KEY_BUFFER);
    expect(decrypted.ok).toBe(true);
    if (decrypted.ok) expect(JSON.parse(decrypted.val)).toEqual({ apiKey: 'rotated-secret' });
  });

  it("borrows a sibling row's key via apiKeyFromId", async () => {
    const sibling: ModelConfigRow = {
      ...baseRow,
      id: ROW_2,
      label: 'Sibling',
      encrypted_secrets: encrypt(JSON.stringify({ apiKey: 'sibling-secret' }), KEY_BUFFER),
    };
    const db = fakeDb([{ ...baseRow }, sibling]);

    const response = await PUT(
      reqOf({
        label: 'Prod Claude',
        provider: 'anthropic',
        model: 'claude-sonnet-5',
        apiKeyFromId: ROW_2,
      }),
      { params: paramsOf() }
    );

    expect(response.status).toBe(200);
    expect(db.rows[0]!.encrypted_secrets).toBe(sibling.encrypted_secrets);
  });

  it('rejects an update when no key is stored and none is provided', async () => {
    fakeDb([{ ...baseRow, encrypted_secrets: '' }]);

    const response = await PUT(
      reqOf({ label: 'Prod Claude', provider: 'anthropic', model: 'claude-sonnet-5' }),
      { params: paramsOf() }
    );
    expect(response.status).toBe(400);
  });

  it('404s for a model that does not exist', async () => {
    fakeDb([]);

    const response = await PUT(
      reqOf({ label: 'x', provider: 'anthropic', model: 'claude-sonnet-5', apiKey: 'k' }),
      { params: paramsOf() }
    );
    expect(response.status).toBe(404);
  });
});

describe('PUT then the stored row: an edit replaces the settings the form sent', () => {
  it('stores the new counts and data handling, and drops what the form left blank', async () => {
    const db = fakeDb([
      { ...baseRow, settings: { reasoningEffort: 'low', apiVersion: 'preview' } },
    ]);

    const response = await PUT(
      reqOf({
        label: 'Prod Claude',
        provider: 'anthropic',
        model: 'claude-sonnet-5',
        contextWindow: 200_000,
        maxOutputTokens: 8000,
        providerRetention: 'none',
        baaCovered: true,
      }),
      { params: paramsOf() }
    );

    expect(response.status).toBe(200);
    expect(db.rows[0]!.settings).toEqual({
      contextWindow: 200_000,
      maxOutputTokens: 8000,
      providerRetention: 'none',
      baaCovered: true,
    });
  });

  it('an edit that turns a row into an image model takes the default away', async () => {
    const db = fakeDb([{ ...baseRow, provider: 'openai', is_default: true }]);

    const response = await PUT(
      reqOf({
        label: 'Prod Claude',
        provider: 'openai',
        model: 'gpt-image-1',
        apiSurface: 'images',
        isDefault: true,
      }),
      { params: paramsOf() }
    );

    expect(response.status).toBe(200);
    expect(db.rows[0]!.is_default).toBe(false);
    expect(db.rows[0]!.settings).toEqual({ apiSurface: 'images' });
  });

  it('refuses an image surface on Anthropic and leaves the row as it was', async () => {
    const db = fakeDb([{ ...baseRow }]);

    const response = await PUT(
      reqOf({
        label: 'Prod Claude',
        provider: 'anthropic',
        model: 'claude-sonnet-5',
        apiSurface: 'images',
      }),
      { params: paramsOf() }
    );

    expect(response.status).toBe(400);
    expect(db.rows[0]!.settings).toEqual({});
  });
});

describe('DELETE .../llm-models/[modelId]', () => {
  it('removes the row', async () => {
    const db = fakeDb([{ ...baseRow }]);

    const response = await DELETE(reqOf(undefined, 'DELETE'), { params: paramsOf() });
    expect(response.status).toBe(200);
    expect(db.rows).toHaveLength(0);
  });

  it('404s when nothing matched', async () => {
    fakeDb([]);

    const response = await DELETE(reqOf(undefined, 'DELETE'), {
      params: paramsOf('00000000-0000-4000-8000-000000000f09'),
    });
    expect(response.status).toBe(404);
  });
});

describe('DELETE with people still on the model', () => {
  const deleteReq = (replaceWith?: string) =>
    new NextRequest(
      new Request(
        `http://x/api/admin/llm-models/${ROW_1}${replaceWith ? `?replaceWith=${replaceWith}` : ''}`,
        { method: 'DELETE' }
      )
    );
  const other: ModelConfigRow = { ...baseRow, id: ROW_2, label: 'Other', is_default: true };

  /** ann prefers the model and has a project and a chat on it; bob has a chat. */
  async function inUse() {
    const db = fakeDb([{ ...baseRow }, other]);
    const store = getDataStore();
    const ann = `auth0|ann-${randomUUID()}`;
    const bob = `auth0|bob-${randomUUID()}`;
    await patchChatModelPrefs(ann, { modelId: ROW_1 });
    const project = await store.chatProjects.create({
      ownerSubject: ann,
      name: 'p',
      description: null,
      toolConfig: null,
    });
    await store.chatProjects.update(project, { llmModelId: ROW_1 });
    const chatOf = (ownerSubject: string) =>
      store.chats.create({
        ownerSubject,
        projectId: null,
        llmModelId: ROW_1,
        toolConfig: null,
        thinkingEnabled: false,
        autoMode: false,
        temporary: false,
      });
    const annChat = await chatOf(ann);
    const bobChat = await chatOf(bob);
    const headlines = async (subject: string) =>
      (await store.notifications.list(subject, { limit: 10 })).map((row) => row.headline);
    return { db, store, ann, bob, project, annChat, bobChat, headlines };
  }

  it('moves what was set to it to the replacement and tells each person', async () => {
    const world = await inUse();

    const response = await DELETE(deleteReq(ROW_2), { params: paramsOf() });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ deleted: true, notified: 2 });
    expect((await world.store.chatProjects.get(world.project))?.llmModelId).toBe(ROW_2);
    expect((await world.store.chats.get(world.annChat))?.llmModelId).toBe(ROW_2);
    expect((await world.store.chats.get(world.bobChat))?.llmModelId).toBe(ROW_2);
    expect((await getChatModelPrefs(world.ann, { fresh: true })).modelId).toBe(ROW_2);
    expect(await world.headlines(world.ann)).toEqual([
      'An administrator removed the model "Prod Claude". "Other" replaced it for your preferred chat model, 1 project and 1 chat.',
    ]);
    expect(await world.headlines(world.bob)).toEqual([
      'An administrator removed the model "Prod Claude". "Other" replaced it for 1 chat.',
    ]);
  });

  it('with no replacement leaves them on the organization default, and still tells them', async () => {
    const world = await inUse();

    const response = await DELETE(deleteReq(), { params: paramsOf() });

    expect(response.status).toBe(200);
    expect((await world.store.chatProjects.get(world.project))?.llmModelId).toBeNull();
    expect((await world.store.chats.get(world.bobChat))?.llmModelId).toBeNull();
    expect((await getChatModelPrefs(world.ann, { fresh: true })).modelId).toBeNull();
    expect(await world.headlines(world.bob)).toEqual([
      'An administrator removed the model "Prod Claude". The organization\'s default model replaced it for 1 chat.',
    ]);
  });

  it('refuses a replacement that is the model itself, switched off or unknown, and removes nothing', async () => {
    const world = await inUse();
    await world.store.llmModels.update(ROW_2, {
      label: 'Other',
      provider: 'anthropic',
      model: 'x',
      baseUrl: null,
      settings: {},
      encryptedSecrets: baseRow.encrypted_secrets,
      enabled: false,
      isDefault: false,
    });

    for (const replaceWith of [ROW_1, ROW_2, '00000000-0000-4000-8000-000000000f09']) {
      const response = await DELETE(deleteReq(replaceWith), { params: paramsOf() });
      expect(response.status).toBe(400);
    }
    expect(world.db.rows).toHaveLength(2);
    expect(await world.headlines(world.ann)).toEqual([]);
  });

  it('usage counts who a removal would touch, and what of theirs', async () => {
    await inUse();

    const response = await USAGE(deleteReq(), { params: paramsOf() });

    expect(await response.json()).toEqual({
      people: 2,
      preferences: 1,
      projects: 1,
      chats: 2,
      agents: 0,
    });
  });
});
