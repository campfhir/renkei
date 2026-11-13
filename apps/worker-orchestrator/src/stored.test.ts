import { createMemoryDataStore, registerDataStore, resetDataStore } from '@renkei/db';
import type { AzureSandboxClient } from '@renkei/sandbox-orchestrator';
import { OrchestratorHost } from './host';
import { buildFromStored, checkStored, type StoredRow } from './stored';

const AZURE = {
  subscriptionId: 'bcc23553-20c2-4009-a5e2-ef2740dd125f',
  resourceGroup: 'PRD_INFRA',
  sandboxGroup: 'renkei-sandbox-group',
  region: 'eastus2',
  diskImage: 'renkei-sandbox',
  portAuth: 'anonymous',
};

const row = (overrides: Partial<StoredRow> = {}): StoredRow => ({
  enabled: true,
  settings: { provider: 'azure', azure: AZURE, envNames: ['DATABASE_URL'] },
  secrets: { 'env.DATABASE_URL': 'postgres://sandbox' },
  ...overrides,
});

/** A sandbox group that answers, or refuses with the given words. */
function azureClient(refusal: string | null = null): AzureSandboxClient {
  const never = () => {
    throw new Error('not called in these tests');
  };
  return {
    get: never,
    list: () => ({
      [Symbol.asyncIterator]: () => ({
        next: async () => {
          if (refusal) throw new Error(refusal);
          return { done: true, value: undefined };
        },
      }),
    }),
    beginCreate: never,
    delete: never,
    updatePorts: never,
    removePort: never,
    beginStop: never,
    beginResume: never,
  };
}

const deps = (refusal: string | null = null) => ({ azureClient: async () => azureClient(refusal) });

describe('the organization’s stored sandbox setup', () => {
  it('becomes a provider, the idle rules and each sandbox’s environment', async () => {
    const built = await buildFromStored(
      row({
        settings: {
          provider: 'azure',
          azure: AZURE,
          envNames: ['DATABASE_URL'],
          idleSuspendMinutes: 10,
          idleEvictHours: 12,
        },
      }),
      deps()
    );
    if (typeof built === 'string') throw new Error(built);
    expect(built.provider.name).toBe('azure');
    expect(built.env).toEqual({ DATABASE_URL: 'postgres://sandbox' });
    expect(built.idleSuspendMs).toBe(600_000);
    expect(built.idleDeleteMs).toBe(43_200_000);
  });

  it('can be a Docker engine instead', async () => {
    const built = await buildFromStored(
      row({
        settings: { provider: 'docker', docker: { image: 'renkei-sandbox:dev' } },
        secrets: {},
      })
    );
    if (typeof built === 'string') throw new Error(built);
    expect(built.provider.name).toBe('docker');
  });

  it('makes nothing, and says why in an operator’s words, when it is absent, switched off or incomplete', async () => {
    expect(await buildFromStored(null)).toMatch(/not set up yet.*Organization → Sandboxes/);
    expect(await buildFromStored(row({ enabled: false }), deps())).toMatch(/switched off/);
    expect(
      await buildFromStored(
        row({ settings: { provider: 'azure', azure: { ...AZURE, sandboxGroup: '' } } }),
        deps()
      )
    ).toMatch(/not usable: Enter the sandbox group’s name/);
  });

  it('is tried by asking the sandbox group whether it answers, and says where it reached', async () => {
    expect(await checkStored(row(), deps())).toEqual({
      ok: true,
      detail:
        'Reached the sandbox group "renkei-sandbox-group" in PRD_INFRA (eastus2). No sandbox was made.',
    });
    // A row not yet enabled can be tried all the same.
    expect((await checkStored(row({ enabled: false }), deps())).ok).toBe(true);
  });

  it('that is refused says what the provider said', async () => {
    const tried = await checkStored(row(), deps('AuthorizationFailed: no role assignment'));
    expect(tried.ok).toBe(false);
    expect(tried.detail).toBe(
      'Could not reach the sandbox group "renkei-sandbox-group" in PRD_INFRA (eastus2): AuthorizationFailed: no role assignment'
    );
  });
});

describe('the orchestrator in force', () => {
  const logs: string[] = [];
  const log = (level: string) => (message: string) => void logs.push(`${level}: ${message}`);
  const logger = { info: log('info'), warn: log('warn'), error: log('error') };

  beforeEach(() => {
    logs.length = 0;
    registerDataStore(createMemoryDataStore());
  });
  afterEach(() => resetDataStore());

  function host(read: () => Promise<StoredRow | null>) {
    return new OrchestratorHost({ read, masterKey: 'master', logger, deps: deps() });
  }

  it('is none until the organization sets sandboxes up, and every call is told why', async () => {
    const waiting = host(async () => null);
    await waiting.reload();
    expect(waiting.maybe()).toBeNull();
    expect(() => waiting.current()).toThrow(/not set up yet/);
    expect(waiting.status()).toEqual({
      provider: null,
      problem: expect.stringMatching(/not set up/),
    });
  });

  it('comes into force when an operator saves the setup, with no restart', async () => {
    let stored: StoredRow | null = null;
    const live = host(async () => stored);
    await live.reload();
    stored = row();
    await live.reload();
    expect(live.status()).toEqual({ provider: 'azure', problem: null });
    expect(live.current()).toBe(live.maybe());
  });

  it('is rebuilt only when the setup changes', async () => {
    let stored = row();
    const live = host(async () => stored);
    await live.reload();
    const first = live.current();
    await live.reload();
    expect(live.current()).toBe(first);
    stored = row({ settings: { provider: 'azure', azure: AZURE, idleSuspendMinutes: 5 } });
    await live.reload();
    expect(live.current()).not.toBe(first);
  });

  it('goes out of force when sandboxes are switched off', async () => {
    let stored = row();
    const live = host(async () => stored);
    await live.reload();
    stored = row({ enabled: false });
    await live.reload();
    expect(() => live.current()).toThrow(/switched off/);
  });

  it('stays as it was when the setup cannot be read', async () => {
    let fail = false;
    const live = host(async () => {
      if (fail) throw new Error('database is away');
      return row();
    });
    await live.reload();
    const first = live.current();
    fail = true;
    await live.reload();
    expect(live.current()).toBe(first);
    expect(logs.some((line) => line.startsWith('warn:') && line.includes('kept'))).toBe(true);
  });
});
