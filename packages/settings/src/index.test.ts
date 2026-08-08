/**
 * The settings store's contract: unset means defaults (the old env
 * defaults), stored values override per key, setters invalidate the cache,
 * and the platform base URL is null — not an error — when unset, so callers
 * can fall back to trusted request headers.
 */

jest.mock('@renkei/db', () => ({ getDatabase: jest.fn() }));

import {
  getOrgSettings,
  setOrgSettings,
  getPublicBaseUrl,
  setPublicBaseUrl,
  invalidateSettingsCache,
  DEFAULT_ORG_SETTINGS,
} from './index';

const { getDatabase: mockGetDatabase } = jest.requireMock<{ getDatabase: jest.Mock }>('@renkei/db');

interface FakeStore {
  tenantRows: Map<string, unknown>;
  platformRows: Map<string, unknown>;
  selects: number;
}

function stubDb(): FakeStore {
  const store: FakeStore = { tenantRows: new Map(), platformRows: new Map(), selects: 0 };

  const makeSelect = (table: string) => {
    const filters: Record<string, unknown> = {};
    const chain = {
      select: () => chain,
      where: (column: string, _op: string, value: unknown) => {
        filters[column] = value;
        return chain;
      },
      execute: async () => {
        store.selects += 1;
        return [...store.tenantRows.entries()]
          .filter(([key]) => key.startsWith(`${String(filters.tenant_id)}:`))
          .map(([key, value]) => ({ key: key.split(':')[1], value }));
      },
      executeTakeFirst: async () => {
        store.selects += 1;
        const value = store.platformRows.get(String(filters.key));
        return value === undefined ? undefined : { value };
      },
    };
    return table === 'tenant_settings' || table === 'platform_settings' ? chain : chain;
  };

  mockGetDatabase.mockReturnValue({
    ok: true,
    val: {
      selectFrom: (table: string) => makeSelect(table),
      insertInto: (table: string) => ({
        values: (row: Record<string, unknown>) => ({
          onConflict: () => ({
            execute: async () => {
              const value = JSON.parse(String(row.value));
              if (table === 'tenant_settings') {
                store.tenantRows.set(`${String(row.tenant_id)}:${String(row.key)}`, value);
              } else {
                store.platformRows.set(String(row.key), value);
              }
              return [];
            },
          }),
        }),
      }),
    },
  });
  return store;
}

beforeEach(() => {
  mockGetDatabase.mockReset();
  invalidateSettingsCache();
});

describe('org settings', () => {
  it('returns defaults for a tenant with nothing stored', async () => {
    stubDb();
    const result = await getOrgSettings('tenant-1');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.val).toEqual(DEFAULT_ORG_SETTINGS);
  });

  it('overrides only what was stored, per key', async () => {
    stubDb();
    await setOrgSettings('tenant-1', { readOnly: true, maxAttachmentBytes: 1024 });

    const result = await getOrgSettings('tenant-1');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.val.readOnly).toBe(true);
      expect(result.val.maxAttachmentBytes).toBe(1024);
      expect(result.val.accessTokenTtlMinutes).toBe(DEFAULT_ORG_SETTINGS.accessTokenTtlMinutes);
    }
  });

  it('ignores stored values of the wrong type in favor of defaults', async () => {
    const store = stubDb();
    store.tenantRows.set('tenant-1:max_jql_results', 'not-a-number');

    const result = await getOrgSettings('tenant-1');
    if (result.ok) expect(result.val.maxJqlResults).toBe(DEFAULT_ORG_SETTINGS.maxJqlResults);
  });

  it('serves cached reads within the TTL and invalidates on write', async () => {
    const store = stubDb();

    await getOrgSettings('tenant-1');
    const afterFirst = store.selects;
    await getOrgSettings('tenant-1');
    expect(store.selects).toBe(afterFirst);

    await setOrgSettings('tenant-1', { readOnly: true });
    const result = await getOrgSettings('tenant-1');
    if (result.ok) expect(result.val.readOnly).toBe(true);
  });
});

describe('public base URL', () => {
  it('is null when unset', async () => {
    stubDb();
    const result = await getPublicBaseUrl();
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.val).toBeNull();
  });

  it('round-trips through the setter with cache invalidation', async () => {
    stubDb();
    await getPublicBaseUrl();
    await setPublicBaseUrl('https://renkei.example.com');
    const result = await getPublicBaseUrl();
    if (result.ok) expect(result.val).toBe('https://renkei.example.com');
  });

  it('prefers PUBLIC_BASE_URL from the environment, trailing slash stripped', async () => {
    stubDb();
    await setPublicBaseUrl('https://stale.example.com');
    process.env.PUBLIC_BASE_URL = 'https://renkei.example.com/';
    try {
      const result = await getPublicBaseUrl();
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.val).toBe('https://renkei.example.com');
    } finally {
      delete process.env.PUBLIC_BASE_URL;
    }
  });

  it('ignores a blank PUBLIC_BASE_URL', async () => {
    stubDb();
    process.env.PUBLIC_BASE_URL = '   ';
    try {
      const result = await getPublicBaseUrl();
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.val).toBeNull();
    } finally {
      delete process.env.PUBLIC_BASE_URL;
    }
  });
});
