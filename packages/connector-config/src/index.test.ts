/**
 * The config store's contract: secrets round-trip through the secretbox and
 * come back typed; missing rows are null, not errors; the cached read serves
 * within its TTL and never caches an error as "not configured".
 */

import { randomBytes } from 'node:crypto';
import { encrypt, isBoundEnvelope, revealContent } from '@renkei/crypto';
import {
  createMemoryDataStore,
  registerDataStore,
  resetDataStore,
  type MemoryDataStore,
} from '@renkei/db';
import {
  getConnectorConfig,
  setConnectorConfig,
  readConnectorConfigCached,
  invalidateConnectorConfigCache,
  configCacheTtlMs,
  CONFIG_CACHE_TTL_MS,
} from './index';

const KEY = randomBytes(32);

let store: MemoryDataStore;

beforeEach(() => {
  store = createMemoryDataStore();
  registerDataStore(store);
  invalidateConnectorConfigCache();
});

afterAll(() => {
  resetDataStore();
});

describe('connector config store', () => {
  it('round-trips settings and encrypted secrets', async () => {
    const write = await setConnectorConfig(
      'webex',
      {
        enabled: true,
        settings: { region: 'us' },
        secrets: { botToken: 'bot-token-1', webhookSecret: 'hook-secret-1' },
      },
      KEY
    );
    expect(write.ok).toBe(true);

    const read = await getConnectorConfig('webex', KEY);
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
    await setConnectorConfig(
      'webex',
      { enabled: true, settings: {}, secrets: { botToken: 'super-secret-token' } },
      KEY
    );

    const stored = String(
      store.tables.first('connector_configs', (r) => r.connector === 'webex')?.encrypted_secrets
    );
    expect(stored).not.toContain('super-secret-token');
    expect(stored.startsWith('v3.')).toBe(true);
  });

  it('returns null for an unconfigured connector', async () => {
    const read = await getConnectorConfig('webex', KEY);
    expect(read.ok).toBe(true);
    if (read.ok) expect(read.val).toBeNull();
  });

  it('reports DECRYPTION_ERROR under the wrong key instead of leaking', async () => {
    await setConnectorConfig(
      'webex',
      { enabled: true, settings: {}, secrets: { botToken: 't' } },
      KEY
    );

    const read = await getConnectorConfig('webex', randomBytes(32));
    expect(read.ok).toBe(false);
  });

  it('serves cached reads within the TTL without re-querying', async () => {
    await setConnectorConfig(
      'webex',
      { enabled: true, settings: {}, secrets: { botToken: 't' } },
      KEY
    );

    const reads = jest.spyOn(store.connectorConfigs, 'get');
    await readConnectorConfigCached('webex', KEY);
    expect(reads).toHaveBeenCalledTimes(1);
    await readConnectorConfigCached('webex', KEY);

    expect(reads).toHaveBeenCalledTimes(1);
  });

  it('keeps a minute-long cache unless RENKEI_CONFIG_CACHE_TTL_MS names another lifetime', () => {
    expect(CONFIG_CACHE_TTL_MS).toBe(60_000);
    expect(configCacheTtlMs({})).toBe(60_000);
    expect(configCacheTtlMs({ RENKEI_CONFIG_CACHE_TTL_MS: ' ' })).toBe(60_000);
    expect(configCacheTtlMs({ RENKEI_CONFIG_CACHE_TTL_MS: 'never' })).toBe(60_000);
    expect(configCacheTtlMs({ RENKEI_CONFIG_CACHE_TTL_MS: '0' })).toBe(0);
    expect(configCacheTtlMs({ RENKEI_CONFIG_CACHE_TTL_MS: '250' })).toBe(250);
  });

  it('asks the store on every read with a zero lifetime', async () => {
    await setConnectorConfig(
      'webex',
      { enabled: true, settings: {}, secrets: { botToken: 't' } },
      KEY
    );
    const reads = jest.spyOn(store.connectorConfigs, 'get');
    process.env.RENKEI_CONFIG_CACHE_TTL_MS = '0';
    try {
      await readConnectorConfigCached('webex', KEY);
      await readConnectorConfigCached('webex', KEY);
      expect(reads).toHaveBeenCalledTimes(2);
    } finally {
      delete process.env.RENKEI_CONFIG_CACHE_TTL_MS;
    }
  });
});

describe('connector secrets are bound to their connector (audit R-04)', () => {
  it('seals as an AAD-bound envelope', async () => {
    await setConnectorConfig('github', { enabled: true, settings: {}, secrets: { s: '1' } }, KEY);
    const row = await store.connectorConfigs.get('github');
    expect(isBoundEnvelope(row?.encryptedSecrets ?? '')).toBe(true);
  });

  it('a blob copied to another connector row does not decrypt there', async () => {
    await setConnectorConfig('github', { enabled: true, settings: {}, secrets: { s: '1' } }, KEY);
    const row = await store.connectorConfigs.get('github');
    await store.connectorConfigs.upsert({
      connector: 'jira',
      enabled: true,
      settings: {},
      encryptedSecrets: row?.encryptedSecrets ?? '',
    });
    expect((await getConnectorConfig('jira', KEY)).ok).toBe(false);
    expect((await getConnectorConfig('github', KEY)).ok).toBe(true);
  });

  it('a legacy (no AAD) row still reads', async () => {
    await store.connectorConfigs.upsert({
      connector: 'webex',
      enabled: true,
      settings: {},
      encryptedSecrets: encrypt(JSON.stringify({ botToken: 'old' }), KEY),
    });
    const read = await getConnectorConfig('webex', KEY);
    expect(read.ok && read.val?.secrets).toEqual({ botToken: 'old' });
  });

  it('the knowledge reader refuses the sealed secrets copied into a chunk', async () => {
    await setConnectorConfig(
      'github',
      { enabled: true, settings: {}, secrets: { s: 'hush' } },
      KEY
    );
    const row = await store.connectorConfigs.get('github');
    const shown = revealContent(`renc1:${row?.encryptedSecrets ?? ''}`, KEY);
    expect(shown).toBe('[content unavailable: decryption failed]');
  });
});
