/**
 * The config store's contract: secrets round-trip through the secretbox and
 * come back typed; missing rows are null, not errors; the cached read serves
 * within its TTL and never caches an error as "not configured".
 */

jest.mock('@renkei/db', () => ({ getDatabase: jest.fn() }));

import { randomBytes } from 'node:crypto';
import {
  getConnectorConfig,
  setConnectorConfig,
  readConnectorConfigCached,
  invalidateConnectorConfigCache,
} from './index';

const { getDatabase: mockGetDatabase } = jest.requireMock<{ getDatabase: jest.Mock }>('@renkei/db');

const KEY = randomBytes(32);

interface FakeStore {
  rows: Map<string, Record<string, unknown>>;
  selects: number;
}

function stubDb(): FakeStore {
  const store: FakeStore = { rows: new Map(), selects: 0 };

  const makeSelect = () => {
    const filters: Record<string, unknown> = {};
    const chain = {
      select: () => chain,
      where: (column: string, _op: string, value: unknown) => {
        filters[column] = value;
        return chain;
      },
      executeTakeFirst: async () => {
        store.selects += 1;
        return store.rows.get(`${String(filters.tenant_id)}:${String(filters.connector)}`);
      },
    };
    return chain;
  };

  mockGetDatabase.mockReturnValue({
    ok: true,
    val: {
      selectFrom: makeSelect,
      insertInto: () => ({
        values: (row: Record<string, unknown>) => ({
          onConflict: () => ({
            execute: async () => {
              store.rows.set(`${String(row.tenant_id)}:${String(row.connector)}`, {
                enabled: row.enabled,
                settings: JSON.parse(String(row.settings)),
                encrypted_secrets: row.encrypted_secrets,
              });
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
  invalidateConnectorConfigCache();
});

describe('connector config store', () => {
  it('round-trips settings and encrypted secrets', async () => {
    stubDb();

    const write = await setConnectorConfig(
      'tenant-1',
      'webex',
      {
        enabled: true,
        settings: { region: 'us' },
        secrets: { botToken: 'bot-token-1', webhookSecret: 'hook-secret-1' },
      },
      KEY
    );
    expect(write.ok).toBe(true);

    const read = await getConnectorConfig('tenant-1', 'webex', KEY);
    expect(read.ok).toBe(true);
    if (read.ok) {
      expect(read.val).not.toBeNull();
      expect(read.val?.enabled).toBe(true);
      expect(read.val?.settings).toEqual({ region: 'us' });
      expect(read.val?.secrets).toEqual({
        botToken: 'bot-token-1',
        webhookSecret: 'hook-secret-1',
      });
    }
  });

  it('stores no plaintext secret material', async () => {
    const store = stubDb();

    await setConnectorConfig(
      'tenant-1',
      'webex',
      { enabled: true, settings: {}, secrets: { botToken: 'super-secret-token' } },
      KEY
    );

    const stored = String(store.rows.get('tenant-1:webex')?.encrypted_secrets);
    expect(stored).not.toContain('super-secret-token');
    expect(stored.startsWith('v1.')).toBe(true);
  });

  it('returns null for an unconfigured connector', async () => {
    stubDb();
    const read = await getConnectorConfig('tenant-1', 'webex', KEY);
    expect(read.ok).toBe(true);
    if (read.ok) expect(read.val).toBeNull();
  });

  it('reports DECRYPTION_ERROR under the wrong key instead of leaking', async () => {
    stubDb();
    await setConnectorConfig(
      'tenant-1',
      'webex',
      { enabled: true, settings: {}, secrets: { botToken: 't' } },
      KEY
    );

    const read = await getConnectorConfig('tenant-1', 'webex', randomBytes(32));
    expect(read.ok).toBe(false);
  });

  it('serves cached reads within the TTL without re-querying', async () => {
    const store = stubDb();
    await setConnectorConfig(
      'tenant-1',
      'webex',
      { enabled: true, settings: {}, secrets: { botToken: 't' } },
      KEY
    );

    await readConnectorConfigCached('tenant-1', 'webex', KEY);
    const selectsAfterFirst = store.selects;
    await readConnectorConfigCached('tenant-1', 'webex', KEY);

    expect(store.selects).toBe(selectsAfterFirst);
  });
});
