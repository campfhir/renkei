/**
 * The settings store's contract: unset means defaults (the old env
 * defaults), stored values override per key, setters invalidate the cache,
 * and the public base URL comes from the environment — null when unset, so
 * callers can fall back to trusted request headers.
 */

import {
  createMemoryDataStore,
  registerDataStore,
  resetDataStore,
  type DataStore,
  type MemoryDataStore,
} from '@renkei/db';
import {
  getOrgSettings,
  setOrgSettings,
  getPublicBaseUrl,
  invalidateSettingsCache,
  coerceStringListRecord,
  DEFAULT_ORG_SETTINGS,
  DEFAULT_SETTINGS_CACHE_TTL_MS,
  settingsCacheTtlMs,
} from './index';

/**
 * A memory data store, registered as the process's store, that counts the
 * reads which reach it — the cache tests need to see whether one did.
 */
function stubStore(): MemoryDataStore & { reads: () => number } {
  const store = createMemoryDataStore();
  let reads = 0;
  const all = store.settings.all;
  const counted: DataStore['settings'] = {
    ...store.settings,
    all: () => {
      reads += 1;
      return all();
    },
  };
  const stub = { ...store, settings: counted, reads: () => reads };
  registerDataStore(stub);
  return stub;
}

beforeEach(() => {
  invalidateSettingsCache();
});

afterAll(() => {
  resetDataStore();
});

describe('org settings', () => {
  it('returns defaults for an organization with nothing stored', async () => {
    stubStore();
    const result = await getOrgSettings();
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.val).toEqual(DEFAULT_ORG_SETTINGS);
  });

  it('bounds log and chat retention by default; 0 (forever) is an opt-in', () => {
    // Both defaulted to 0 before: a fresh org kept every log row (request
    // and response bodies included) and every chat indefinitely unless an
    // admin found the dial. Unbounded retention is now something an org
    // chooses, not something it inherits.
    expect(DEFAULT_ORG_SETTINGS.logRetentionDays).toBe(90);
    expect(DEFAULT_ORG_SETTINGS.chatRetentionDays).toBe(365);
  });

  it('overrides only what was stored, per key', async () => {
    stubStore();
    await setOrgSettings({ readOnly: true, maxAttachmentBytes: 1024 });

    const result = await getOrgSettings();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.val.readOnly).toBe(true);
      expect(result.val.maxAttachmentBytes).toBe(1024);
      expect(result.val.accessTokenTtlMinutes).toBe(DEFAULT_ORG_SETTINGS.accessTokenTtlMinutes);
    }
  });

  it('carries the sandbox ceilings and the AD Manager product name, with code defaults', async () => {
    // Formerly SANDBOX_SCRIPT_MEMORY, SANDBOX_SERVICE_MEMORY,
    // SANDBOX_SERVICE_PIDS, SANDBOX_WORKSPACES_DEBUG and
    // ADMANAGER_PRODUCT_NAME: nothing stored means the defaults in code, and
    // what is stored is read per key.
    stubStore();
    expect(DEFAULT_ORG_SETTINGS.sandboxScriptMemoryBytes).toBe(2 * 1_073_741_824);
    expect(DEFAULT_ORG_SETTINGS.sandboxServiceMemoryBytes).toBe(1_073_741_824);
    expect(DEFAULT_ORG_SETTINGS.sandboxServicePids).toBe(512);
    expect(DEFAULT_ORG_SETTINGS.sandboxWorkspacesDebug).toBe(false);
    expect(DEFAULT_ORG_SETTINGS.admanagerProductName).toBe('Renkei');

    await setOrgSettings({
      sandboxServiceMemoryBytes: 1536 * 1_048_576,
      sandboxServicePids: 128,
      sandboxWorkspacesDebug: true,
      admanagerProductName: 'Acme Renkei',
    });
    const result = await getOrgSettings();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.val.sandboxServiceMemoryBytes).toBe(1536 * 1_048_576);
      expect(result.val.sandboxServicePids).toBe(128);
      expect(result.val.sandboxWorkspacesDebug).toBe(true);
      expect(result.val.admanagerProductName).toBe('Acme Renkei');
      expect(result.val.sandboxScriptMemoryBytes).toBe(
        DEFAULT_ORG_SETTINGS.sandboxScriptMemoryBytes
      );
    }
  });

  it('ignores stored values of the wrong type in favor of defaults', async () => {
    const store = stubStore();
    await store.settings.set('max_jql_results', 'not-a-number');

    const result = await getOrgSettings();
    if (result.ok) expect(result.val.maxJqlResults).toBe(DEFAULT_ORG_SETTINGS.maxJqlResults);
  });

  it('rejects a stored log level outside the known set in favor of the default', async () => {
    const store = stubStore();
    await store.settings.set('log_level', 'trace');

    const result = await getOrgSettings();
    if (result.ok) expect(result.val.logLevel).toBe(DEFAULT_ORG_SETTINGS.logLevel);
  });

  it('defaults act-step approval to externally triggered runs, and refuses an unknown policy', async () => {
    const store = stubStore();
    const policyOf = async () => {
      const result = await getOrgSettings();
      return result.ok ? result.val.agentActStepsRequireApproval : null;
    };
    expect(await policyOf()).toBe('externally_triggered');

    await store.settings.set('agent_act_steps_require_approval', 'sometimes');
    invalidateSettingsCache();
    expect(await policyOf()).toBe('externally_triggered');

    await setOrgSettings({ agentActStepsRequireApproval: 'off' });
    expect(await policyOf()).toBe('off');
  });

  it('round-trips a valid log level', async () => {
    stubStore();
    await setOrgSettings({ logLevel: 'debug' });

    const result = await getOrgSettings();
    if (result.ok) expect(result.val.logLevel).toBe('debug');
  });

  it('serves cached reads within the TTL and invalidates on write', async () => {
    const store = stubStore();

    await getOrgSettings();
    const afterFirst = store.reads();
    await getOrgSettings();
    expect(store.reads()).toBe(afterFirst);

    await setOrgSettings({ readOnly: true });
    const result = await getOrgSettings();
    if (result.ok) expect(result.val.readOnly).toBe(true);
  });

  it('keeps a minute-long cache unless RENKEI_CONFIG_CACHE_TTL_MS names another lifetime', () => {
    expect(DEFAULT_SETTINGS_CACHE_TTL_MS).toBe(60_000);
    expect(settingsCacheTtlMs({})).toBe(60_000);
    expect(settingsCacheTtlMs({ RENKEI_CONFIG_CACHE_TTL_MS: '' })).toBe(60_000);
    expect(settingsCacheTtlMs({ RENKEI_CONFIG_CACHE_TTL_MS: 'soon' })).toBe(60_000);
    expect(settingsCacheTtlMs({ RENKEI_CONFIG_CACHE_TTL_MS: '-5' })).toBe(60_000);
    expect(settingsCacheTtlMs({ RENKEI_CONFIG_CACHE_TTL_MS: '0' })).toBe(0);
    expect(settingsCacheTtlMs({ RENKEI_CONFIG_CACHE_TTL_MS: '5000' })).toBe(5_000);
  });

  it('asks the store on every read with a zero lifetime', async () => {
    const store = stubStore();
    process.env.RENKEI_CONFIG_CACHE_TTL_MS = '0';
    try {
      await getOrgSettings();
      const afterFirst = store.reads();
      await getOrgSettings();
      expect(store.reads()).toBeGreaterThan(afterFirst);
    } finally {
      delete process.env.RENKEI_CONFIG_CACHE_TTL_MS;
    }
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

describe('connector audiences', () => {
  it('round-trips a map of group lists and drops anything malformed', async () => {
    stubStore();
    await setOrgSettings({
      connectorAudiences: { zoom: ['svc-desk', 'ops'], 'atlassian-bitbucket': [] },
    });
    const settings = await getOrgSettings();
    expect(settings.ok && settings.val.connectorAudiences).toEqual({
      zoom: ['svc-desk', 'ops'],
      'atlassian-bitbucket': [],
    });
  });

  it('coerces defensively: non-object → default, non-list values dropped, empties kept', () => {
    expect(coerceStringListRecord('zoom', { a: ['x'] })).toEqual({ a: ['x'] });
    expect(coerceStringListRecord(['zoom'], {})).toEqual({});
    expect(coerceStringListRecord({ zoom: 'svc', jira: ['a', 3, ''], onbase: [] }, {})).toEqual({
      jira: ['a'],
      onbase: [],
    });
  });
});
