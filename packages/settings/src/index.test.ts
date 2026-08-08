/**
 * The settings store's contract: unset means defaults (the old env
 * defaults), stored values override per key, setters invalidate the cache,
 * and the public base URL comes from the environment — null when unset, so
 * callers can fall back to trusted request headers.
 */

jest.mock('@renkei/db', () => ({ getDatabase: jest.fn() }));

import {
  getOrgSettings,
  setOrgSettings,
  getPublicBaseUrl,
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
  afterEach(() => {
    delete process.env.PUBLIC_BASE_URL;
  });

  it('is null when PUBLIC_BASE_URL is unset', () => {
    expect(getPublicBaseUrl()).toBeNull();
  });

  it('reads PUBLIC_BASE_URL, trailing slash stripped', () => {
    process.env.PUBLIC_BASE_URL = 'https://renkei.example.com/';
    expect(getPublicBaseUrl()).toBe('https://renkei.example.com');
  });

  it('treats a blank PUBLIC_BASE_URL as unset', () => {
    process.env.PUBLIC_BASE_URL = '   ';
    expect(getPublicBaseUrl()).toBeNull();
  });
});
