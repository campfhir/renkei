/**
 * The model roster's save path: does a POST actually persist an encrypted,
 * decryptable key, and does GET only ever report presence? Nothing
 * previously exercised this route — it's the surface a MaaS provider like
 * Azure AI Foundry rides on unchanged (same table, same encrypt-on-write,
 * distinguished only by `provider`/`base_url`), so a regression here would
 * silently break every provider at once.
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
import { randomBytes } from 'node:crypto';
import { decrypt, parseEncryptionKey } from '@renkei/crypto';
import { createMemoryDataStore, registerDataStore, resetDataStore } from '@renkei/db';
import { GET, POST } from './route';

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

/** A memory data store holding these model rows; `inserted` is what the route added. */
function fakeDb(seed: ModelConfigRow[]) {
  const store = createMemoryDataStore();
  store.tables.seed({ llm_model_configs: seed });
  registerDataStore(store);
  const seeded = new Set(seed.map((row) => row.id));
  return {
    get rows() {
      return store.tables.select('llm_model_configs');
    },
    get inserted() {
      return store.tables.select('llm_model_configs', (row) => !seeded.has(row.id));
    },
  };
}

const ENCRYPTION_KEY = randomBytes(32).toString('base64');

function reqOf(body: unknown): NextRequest {
  return new NextRequest(
    new Request('http://x/api/admin/acme/llm-models', {
      method: 'POST',
      body: JSON.stringify(body),
    })
  );
}

afterAll(() => {
  resetDataStore();
});

beforeEach(() => {
  jest.clearAllMocks();
  mockCheckAccess.mockResolvedValue({ subject: 'auth0|alice' });
  process.env.TOKEN_ENCRYPTION_KEY = ENCRYPTION_KEY;
});

describe('POST .../llm-models', () => {
  it('encrypts the typed apiKey and stores it decryptable', async () => {
    const db = fakeDb([]);

    const response = await POST(
      reqOf({
        label: 'Prod Claude',
        provider: 'anthropic',
        model: 'claude-sonnet-5',
        apiKey: 'sk-ant-secret',
      })
    );

    expect(response.status).toBe(201);
    expect(db.inserted).toHaveLength(1);
    const stored = db.inserted[0]!.encrypted_secrets;
    expect(stored).not.toBeNull();
    expect(stored).not.toContain('sk-ant-secret');

    const keyResult = parseEncryptionKey(ENCRYPTION_KEY);
    expect(keyResult.ok).toBe(true);
    const decrypted = keyResult.ok ? decrypt(stored!, keyResult.val) : null;
    expect(decrypted?.ok).toBe(true);
    if (decrypted?.ok) expect(JSON.parse(decrypted.val)).toEqual({ apiKey: 'sk-ant-secret' });
  });

  it('stores an image generation model by its images API surface, and never as the org default', async () => {
    const db = fakeDb([]);

    const response = await POST(
      reqOf({
        label: 'Painter',
        provider: 'openai',
        model: 'gpt-image-1',
        apiKey: 'sk-x',
        apiSurface: 'images',
        isDefault: true,
      })
    );

    expect(response.status).toBe(201);
    expect(db.inserted[0]!.settings).toEqual({ apiSurface: 'images' });
    expect(db.inserted[0]!.is_default).toBe(false);
  });

  it('stores a FLUX model by its flux surface too, and never as the org default', async () => {
    const db = fakeDb([]);

    const response = await POST(
      reqOf({
        label: 'Fox',
        provider: 'openai',
        model: 'FLUX.2-flex',
        apiKey: 'sk-x',
        apiSurface: 'flux',
        apiVersion: 'preview',
        isDefault: true,
      })
    );

    expect(response.status).toBe(201);
    expect(db.inserted[0]!.settings).toEqual({
      apiSurface: 'flux',
      apiVersion: 'preview',
    });
    expect(db.inserted[0]!.is_default).toBe(false);
  });

  it('still lets a chat model be the default on either chat surface', async () => {
    const db = fakeDb([]);

    const response = await POST(
      reqOf({
        label: 'Chatty',
        provider: 'openai',
        model: 'gpt-x',
        apiKey: 'sk-x',
        apiSurface: 'responses',
        isDefault: true,
      })
    );

    expect(response.status).toBe(201);
    expect(db.inserted[0]!.is_default).toBe(true);
  });

  it('refuses the images API surface on a provider with no Images API', async () => {
    const db = fakeDb([]);

    const response = await POST(
      reqOf({
        label: 'Nope',
        provider: 'anthropic',
        model: 'claude-x',
        apiKey: 'sk-x',
        apiSurface: 'flux',
      })
    );

    expect(response.status).toBe(400);
    expect(db.inserted).toHaveLength(0);
  });

  it('rejects a save with neither an apiKey nor a key to reuse', async () => {
    fakeDb([]);
    const response = await POST(
      reqOf({ label: 'No key', provider: 'anthropic', model: 'claude-sonnet-5' })
    );
    expect(response.status).toBe(400);
  });

  it("borrows a sibling row's stored key via apiKeyFromId without retyping it", async () => {
    const db = fakeDb([
      {
        id: '00000000-0000-4000-8000-000000000e01',
        label: 'Existing',
        provider: 'anthropic',
        model: 'claude-sonnet-5',
        base_url: null,
        settings: {},
        encrypted_secrets: 'v1.iv.tag.cipher',
        enabled: true,
        is_default: false,
      },
    ]);

    const response = await POST(
      reqOf({
        label: 'Second row, same key',
        provider: 'anthropic',
        model: 'claude-haiku-4-5',
        apiKeyFromId: '00000000-0000-4000-8000-000000000e01',
      })
    );

    expect(response.status).toBe(201);
    expect(db.inserted[0]!.encrypted_secrets).toBe('v1.iv.tag.cipher');
  });

  it('generalizes to an Azure AI Foundry deployment via base_url on the same provider dialect', async () => {
    const db = fakeDb([]);

    const response = await POST(
      reqOf({
        label: 'Azure Claude',
        provider: 'anthropic',
        model: 'my-claude-deployment',
        baseUrl: 'https://resource.services.ai.azure.com/anthropic',
        apiVersion: '2024-05-01-preview',
        apiKey: 'azure-secret',
      })
    );

    expect(response.status).toBe(201);
    expect(db.inserted[0]).toMatchObject({
      provider: 'anthropic',
      base_url: 'https://resource.services.ai.azure.com/anthropic',
    });
    expect(db.inserted[0]!.encrypted_secrets).not.toContain('azure-secret');
  });

  it('clears the previous default when the new row is marked default', async () => {
    const db = fakeDb([
      {
        id: '00000000-0000-4000-8000-000000000e02',
        label: 'Old default',
        provider: 'anthropic',
        model: 'claude-sonnet-5',
        base_url: null,
        settings: {},
        encrypted_secrets: 'v1.iv.tag.cipher',
        enabled: true,
        is_default: true,
      },
    ]);

    await POST(
      reqOf({
        label: 'New default',
        provider: 'anthropic',
        model: 'claude-sonnet-5',
        apiKey: 'sk-new',
        isDefault: true,
      })
    );

    expect(
      db.rows.find((row) => row.id === '00000000-0000-4000-8000-000000000e02')!.is_default
    ).toBe(false);
    expect(db.rows.find((row) => row.label === 'New default')!.is_default).toBe(true);
  });

  it('rejects a duplicate label with 409', async () => {
    fakeDb([
      {
        id: '00000000-0000-4000-8000-000000000e01',
        label: 'Taken',
        provider: 'anthropic',
        model: 'claude-sonnet-5',
        base_url: null,
        settings: {},
        encrypted_secrets: 'v1.iv.tag.cipher',
        enabled: true,
        is_default: false,
      },
    ]);

    const response = await POST(
      reqOf({ label: 'Taken', provider: 'anthropic', model: 'claude-sonnet-5', apiKey: 'sk-new' })
    );
    expect(response.status).toBe(409);
  });
});

describe('GET .../llm-models', () => {
  it('reports key presence only, never the stored value', async () => {
    fakeDb([
      {
        id: '00000000-0000-4000-8000-000000000e03',
        label: 'Has key',
        provider: 'anthropic',
        model: 'claude-sonnet-5',
        base_url: null,
        settings: {},
        encrypted_secrets: 'v1.iv.tag.cipher',
        enabled: true,
        is_default: true,
      },
      {
        id: '00000000-0000-4000-8000-000000000e04',
        label: 'No key',
        provider: 'openai',
        model: 'gpt-5',
        base_url: null,
        settings: {},
        encrypted_secrets: '',
        enabled: true,
        is_default: false,
      },
    ]);

    const response = await GET(new NextRequest('http://x/api/admin/acme/llm-models'));
    const body: { models: { label: string; hasApiKey: boolean }[] } = await response.json();

    expect(JSON.stringify(body)).not.toContain('v1.iv.tag.cipher');
    expect(body.models.find((m) => m.label === 'Has key')!.hasApiKey).toBe(true);
    expect(body.models.find((m) => m.label === 'No key')!.hasApiKey).toBe(false);
  });
});
