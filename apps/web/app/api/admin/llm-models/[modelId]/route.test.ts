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
import { randomBytes } from 'node:crypto';
import {
  AAD_PURPOSE,
  aadFor,
  decryptBoundValue,
  encrypt,
  parseEncryptionKey,
} from '@renkei/crypto';
import { createMemoryDataStore, registerDataStore, resetDataStore } from '@renkei/db';
import { DELETE, PUT } from './route';

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
    const decrypted = decryptBoundValue(stored, KEY_BUFFER, aadFor(AAD_PURPOSE.llmModelKey));
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
    const decrypted = decryptBoundValue(
      db.rows[0]!.encrypted_secrets,
      KEY_BUFFER,
      aadFor(AAD_PURPOSE.llmModelKey)
    );
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
