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
jest.mock('@renkei/db', () => ({ getDatabase: jest.fn() }));
jest.mock('@renkei/agent-llm', () => ({
  ...jest.requireActual('@renkei/agent-llm'),
  invalidateLlmCache: jest.fn(),
}));

import { NextRequest } from 'next/server';
import { randomBytes } from 'node:crypto';
import { decrypt, parseEncryptionKey } from '@renkei/crypto';
import { GET, POST } from './route';

const { checkAccess: mockCheckAccess } = jest.requireMock<{ checkAccess: jest.Mock }>(
  '@/lib/access'
);
const { getDatabase: mockGetDatabase } = jest.requireMock<{ getDatabase: jest.Mock }>('@renkei/db');

interface ModelConfigRow {
  id: string;
  label: string;
  provider: string;
  model: string;
  base_url: string | null;
  settings: unknown;
  encrypted_secrets: string | null;
  enabled: boolean;
  is_default: boolean;
}

type Where = [string, string, unknown];

function matches(row: ModelConfigRow, wheres: Where[]): boolean {
  return wheres.every(([col, op, val]) => {
    const cell = Reflect.get(row, col);
    return op === '!=' ? cell !== val : cell === val;
  });
}

/** A minimal in-memory `llm_model_configs` table over Kysely's shape. */
function fakeDb(seed: ModelConfigRow[]) {
  const rows = [...seed];
  const inserted: ModelConfigRow[] = [];

  function select() {
    const wheres: Where[] = [];
    const builder = {
      select: () => builder,
      where: (col: string, op: string, val: unknown) => {
        wheres.push([col, op, val]);
        return builder;
      },
      orderBy: () => builder,
      executeTakeFirst: async () => rows.find((row) => matches(row, wheres)),
      execute: async () => rows.filter((row) => matches(row, wheres)),
    };
    return builder;
  }

  function update() {
    const wheres: Where[] = [];
    let patch: Record<string, unknown> = {};
    const builder = {
      set: (values: Record<string, unknown>) => {
        patch = values;
        return builder;
      },
      where: (col: string, op: string, val: unknown) => {
        wheres.push([col, op, val]);
        return builder;
      },
      execute: async () => {
        for (const row of rows) {
          if (matches(row, wheres)) Object.assign(row, patch);
        }
      },
    };
    return builder;
  }

  return {
    rows,
    inserted,
    ok: true as const,
    val: {
      selectFrom: () => select(),
      updateTable: () => update(),
      insertInto: () => ({
        values: (values: Record<string, unknown>) => ({
          execute: async () => {
            if (
              rows.some((row) => row.label === values.label)
            ) {
              throw new Error(
                'duplicate key value violates unique constraint "llm_model_configs_label"'
              );
            }
            const row: ModelConfigRow = {
              id: String(values.id),
              label: String(values.label),
              provider: String(values.provider),
              model: String(values.model),
              base_url: typeof values.base_url === 'string' ? values.base_url : null,
              settings: values.settings,
              encrypted_secrets:
                typeof values.encrypted_secrets === 'string' ? values.encrypted_secrets : null,
              enabled: Boolean(values.enabled),
              is_default: Boolean(values.is_default),
            };
            rows.push(row);
            inserted.push(row);
          },
        }),
      }),
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

beforeEach(() => {
  jest.clearAllMocks();
  mockCheckAccess.mockResolvedValue({ subject: 'auth0|alice' });
  process.env.TOKEN_ENCRYPTION_KEY = ENCRYPTION_KEY;
});

describe('POST .../llm-models', () => {
  it('encrypts the typed apiKey and stores it decryptable', async () => {
    const db = fakeDb([]);
    mockGetDatabase.mockReturnValue(db);

    const response = await POST(
      reqOf({
        label: 'Prod Claude',
        provider: 'anthropic',
        model: 'claude-sonnet-5',
        apiKey: 'sk-ant-secret',
      }));

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
    mockGetDatabase.mockReturnValue(db);

    const response = await POST(
      reqOf({
        label: 'Painter',
        provider: 'openai',
        model: 'gpt-image-1',
        apiKey: 'sk-x',
        apiSurface: 'images',
        isDefault: true,
      }));

    expect(response.status).toBe(201);
    expect(JSON.parse(String(db.inserted[0]!.settings))).toEqual({ apiSurface: 'images' });
    expect(db.inserted[0]!.is_default).toBe(false);
  });

  it('stores a FLUX model by its flux surface too, and never as the org default', async () => {
    const db = fakeDb([]);
    mockGetDatabase.mockReturnValue(db);

    const response = await POST(
      reqOf({
        label: 'Fox',
        provider: 'openai',
        model: 'FLUX.2-flex',
        apiKey: 'sk-x',
        apiSurface: 'flux',
        apiVersion: 'preview',
        isDefault: true,
      }));

    expect(response.status).toBe(201);
    expect(JSON.parse(String(db.inserted[0]!.settings))).toEqual({
      apiSurface: 'flux',
      apiVersion: 'preview',
    });
    expect(db.inserted[0]!.is_default).toBe(false);
  });

  it('still lets a chat model be the default on either chat surface', async () => {
    const db = fakeDb([]);
    mockGetDatabase.mockReturnValue(db);

    const response = await POST(
      reqOf({
        label: 'Chatty',
        provider: 'openai',
        model: 'gpt-x',
        apiKey: 'sk-x',
        apiSurface: 'responses',
        isDefault: true,
      }));

    expect(response.status).toBe(201);
    expect(db.inserted[0]!.is_default).toBe(true);
  });

  it('refuses the images API surface on a provider with no Images API', async () => {
    const db = fakeDb([]);
    mockGetDatabase.mockReturnValue(db);

    const response = await POST(
      reqOf({
        label: 'Nope',
        provider: 'anthropic',
        model: 'claude-x',
        apiKey: 'sk-x',
        apiSurface: 'flux',
      }));

    expect(response.status).toBe(400);
    expect(db.inserted).toHaveLength(0);
  });

  it('rejects a save with neither an apiKey nor a key to reuse', async () => {
    mockGetDatabase.mockReturnValue(fakeDb([]));
    const response = await POST(
      reqOf({ label: 'No key', provider: 'anthropic', model: 'claude-sonnet-5' }));
    expect(response.status).toBe(400);
  });

  it("borrows a sibling row's stored key via apiKeyFromId without retyping it", async () => {
    const db = fakeDb([
      {
        id: 'existing-1',
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
    mockGetDatabase.mockReturnValue(db);

    const response = await POST(
      reqOf({
        label: 'Second row, same key',
        provider: 'anthropic',
        model: 'claude-haiku-4-5',
        apiKeyFromId: 'existing-1',
      }));

    expect(response.status).toBe(201);
    expect(db.inserted[0]!.encrypted_secrets).toBe('v1.iv.tag.cipher');
  });

  it('generalizes to an Azure AI Foundry deployment via base_url on the same provider dialect', async () => {
    const db = fakeDb([]);
    mockGetDatabase.mockReturnValue(db);

    const response = await POST(
      reqOf({
        label: 'Azure Claude',
        provider: 'anthropic',
        model: 'my-claude-deployment',
        baseUrl: 'https://resource.services.ai.azure.com/anthropic',
        apiVersion: '2024-05-01-preview',
        apiKey: 'azure-secret',
      }));

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
        id: 'old-default',
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
    mockGetDatabase.mockReturnValue(db);

    await POST(
      reqOf({
        label: 'New default',
        provider: 'anthropic',
        model: 'claude-sonnet-5',
        apiKey: 'sk-new',
        isDefault: true,
      }));

    expect(db.rows.find((row) => row.id === 'old-default')!.is_default).toBe(false);
    expect(db.rows.find((row) => row.label === 'New default')!.is_default).toBe(true);
  });

  it('rejects a duplicate label with 409', async () => {
    const db = fakeDb([
      {
        id: 'existing-1',
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
    mockGetDatabase.mockReturnValue(db);

    const response = await POST(
      reqOf({ label: 'Taken', provider: 'anthropic', model: 'claude-sonnet-5', apiKey: 'sk-new' }));
    expect(response.status).toBe(409);
  });
});

describe('GET .../llm-models', () => {
  it('reports key presence only, never the stored value', async () => {
    const db = fakeDb([
      {
        id: 'row-1',
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
        id: 'row-2',
        label: 'No key',
        provider: 'openai',
        model: 'gpt-5',
        base_url: null,
        settings: {},
        encrypted_secrets: null,
        enabled: true,
        is_default: false,
      },
    ]);
    mockGetDatabase.mockReturnValue(db);

    const response = await GET(new NextRequest('http://x/api/admin/acme/llm-models'));
    const body: { models: { label: string; hasApiKey: boolean }[] } = await response.json();

    expect(JSON.stringify(body)).not.toContain('v1.iv.tag.cipher');
    expect(body.models.find((m) => m.label === 'Has key')!.hasApiKey).toBe(true);
    expect(body.models.find((m) => m.label === 'No key')!.hasApiKey).toBe(false);
  });
});
