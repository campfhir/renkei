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
jest.mock('@/lib/tenant-slug', () => ({ tenantForSlug: jest.fn() }));
jest.mock('@renkei/db', () => ({ getDatabase: jest.fn() }));
jest.mock('@renkei/agent-llm', () => ({ invalidateLlmCache: jest.fn() }));

import { NextRequest } from 'next/server';
import { randomBytes } from 'node:crypto';
import { decrypt, encrypt, parseEncryptionKey } from '@renkei/crypto';
import { DELETE, PUT } from './route';

const { checkAccess: mockCheckAccess } = jest.requireMock<{ checkAccess: jest.Mock }>(
  '@/lib/access'
);
const { tenantForSlug: mockTenantForSlug } = jest.requireMock<{ tenantForSlug: jest.Mock }>(
  '@/lib/tenant-slug'
);
const { getDatabase: mockGetDatabase } = jest.requireMock<{ getDatabase: jest.Mock }>('@renkei/db');

interface ModelConfigRow {
  id: string;
  tenant_id: string;
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

function fakeDb(seed: ModelConfigRow[]) {
  const rows = [...seed];

  function select() {
    const wheres: Where[] = [];
    const builder = {
      select: () => builder,
      where: (col: string, op: string, val: unknown) => {
        wheres.push([col, op, val]);
        return builder;
      },
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

  function del() {
    const wheres: Where[] = [];
    const builder = {
      where: (col: string, op: string, val: unknown) => {
        wheres.push([col, op, val]);
        return builder;
      },
      executeTakeFirst: async () => {
        const before = rows.length;
        const remaining = rows.filter((row) => !matches(row, wheres));
        const numDeletedRows = BigInt(before - remaining.length);
        rows.length = 0;
        rows.push(...remaining);
        return { numDeletedRows };
      },
    };
    return builder;
  }

  return {
    rows,
    ok: true as const,
    val: {
      selectFrom: () => select(),
      updateTable: () => update(),
      deleteFrom: () => del(),
    },
  };
}

const TENANT = { id: 'tenant-1', slug: 'acme' };
const ENCRYPTION_KEY = randomBytes(32).toString('base64');
const keyResult = parseEncryptionKey(ENCRYPTION_KEY);
if (!keyResult.ok) throw new Error('test setup: bad encryption key');
const KEY_BUFFER = keyResult.val;

function reqOf(body: unknown, method = 'PUT'): NextRequest {
  return new NextRequest(
    new Request('http://x/api/admin/acme/llm-models/row-1', { method, body: JSON.stringify(body) })
  );
}
const paramsOf = (modelId = 'row-1') => Promise.resolve({ slug: 'acme', modelId });

const baseRow: ModelConfigRow = {
  id: 'row-1',
  tenant_id: TENANT.id,
  label: 'Prod Claude',
  provider: 'anthropic',
  model: 'claude-sonnet-5',
  base_url: null,
  settings: {},
  encrypted_secrets: encrypt(JSON.stringify({ apiKey: 'original-secret' }), KEY_BUFFER),
  enabled: true,
  is_default: false,
};

beforeEach(() => {
  jest.clearAllMocks();
  mockTenantForSlug.mockResolvedValue(TENANT);
  mockCheckAccess.mockResolvedValue({ subject: 'auth0|alice' });
  process.env.TOKEN_ENCRYPTION_KEY = ENCRYPTION_KEY;
});

describe('PUT .../llm-models/[modelId]', () => {
  it('keeps the stored key when apiKey is blank', async () => {
    const db = fakeDb([{ ...baseRow }]);
    mockGetDatabase.mockReturnValue(db);

    const response = await PUT(
      reqOf({ label: 'Prod Claude (renamed)', provider: 'anthropic', model: 'claude-sonnet-5' }),
      { params: paramsOf() }
    );

    expect(response.status).toBe(200);
    const stored = db.rows[0]!.encrypted_secrets!;
    const decrypted = decrypt(stored, KEY_BUFFER);
    expect(decrypted.ok).toBe(true);
    if (decrypted.ok) expect(JSON.parse(decrypted.val)).toEqual({ apiKey: 'original-secret' });
  });

  it('replaces the key when a new one is typed', async () => {
    const db = fakeDb([{ ...baseRow }]);
    mockGetDatabase.mockReturnValue(db);

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
    const decrypted = decrypt(db.rows[0]!.encrypted_secrets!, KEY_BUFFER);
    expect(decrypted.ok).toBe(true);
    if (decrypted.ok) expect(JSON.parse(decrypted.val)).toEqual({ apiKey: 'rotated-secret' });
  });

  it('borrows a sibling row\'s key via apiKeyFromId', async () => {
    const sibling: ModelConfigRow = {
      ...baseRow,
      id: 'row-2',
      label: 'Sibling',
      encrypted_secrets: encrypt(JSON.stringify({ apiKey: 'sibling-secret' }), KEY_BUFFER),
    };
    const db = fakeDb([{ ...baseRow }, sibling]);
    mockGetDatabase.mockReturnValue(db);

    const response = await PUT(
      reqOf({ label: 'Prod Claude', provider: 'anthropic', model: 'claude-sonnet-5', apiKeyFromId: 'row-2' }),
      { params: paramsOf() }
    );

    expect(response.status).toBe(200);
    expect(db.rows[0]!.encrypted_secrets).toBe(sibling.encrypted_secrets);
  });

  it('rejects an update when no key is stored and none is provided', async () => {
    const db = fakeDb([{ ...baseRow, encrypted_secrets: null }]);
    mockGetDatabase.mockReturnValue(db);

    const response = await PUT(
      reqOf({ label: 'Prod Claude', provider: 'anthropic', model: 'claude-sonnet-5' }),
      { params: paramsOf() }
    );
    expect(response.status).toBe(400);
  });

  it('404s for a model outside this tenant', async () => {
    const db = fakeDb([{ ...baseRow, tenant_id: 'other-tenant' }]);
    mockGetDatabase.mockReturnValue(db);

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
    mockGetDatabase.mockReturnValue(db);

    const response = await DELETE(reqOf(undefined, 'DELETE'), { params: paramsOf() });
    expect(response.status).toBe(200);
    expect(db.rows).toHaveLength(0);
  });

  it('404s when nothing matched', async () => {
    const db = fakeDb([]);
    mockGetDatabase.mockReturnValue(db);

    const response = await DELETE(reqOf(undefined, 'DELETE'), { params: paramsOf('missing') });
    expect(response.status).toBe(404);
  });
});
