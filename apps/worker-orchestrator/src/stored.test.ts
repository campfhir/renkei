import { createMemoryDataStore, registerDataStore, resetDataStore } from '@renkei/db';
import {
  DiskImagePreparer,
  OrchestratorError,
  TrialSandboxes,
  type AzureCreateRequest,
  type AzureSandboxClient,
  type DiskImageClient,
  type DiskImageView,
} from '@renkei/sandbox-orchestrator';
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
  settings: {
    provider: 'azure',
    callbackUrl: 'https://orchestrator.internal:8097',
    azure: AZURE,
    envNames: ['DELEGATE_WORKER_API_KEY'],
  },
  secrets: { 'env.DELEGATE_WORKER_API_KEY': 'delegate-key' },
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
          callbackUrl: 'https://orchestrator.internal:8097/',
          azure: AZURE,
          envNames: ['DELEGATE_WORKER_API_KEY'],
          idleSuspendMinutes: 10,
          idleEvictHours: 12,
        },
      }),
      deps()
    );
    if (typeof built === 'string') throw new Error(built);
    expect(built.provider.name).toBe('azure');
    expect(built.env).toEqual({ DELEGATE_WORKER_API_KEY: 'delegate-key' });
    expect(built.callbackUrl).toBe('https://orchestrator.internal:8097');
    expect(built.idleSuspendMs).toBe(600_000);
    expect(built.idleDeleteMs).toBe(43_200_000);
  });

  it('can be a Docker engine instead', async () => {
    const built = await buildFromStored(
      row({
        settings: {
          provider: 'docker',
          callbackUrl: 'http://renkei-worker-orchestrator:8097',
          docker: { image: 'renkei-sandbox:dev' },
        },
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
        row({
          settings: {
            provider: 'azure',
            callbackUrl: 'https://o.internal',
            azure: { ...AZURE, sandboxGroup: '' },
          },
        }),
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
      image: null,
    });
  });

  it('comes into force when an operator saves the setup, with no restart', async () => {
    let stored: StoredRow | null = null;
    const live = host(async () => stored);
    await live.reload();
    stored = row();
    await live.reload();
    expect(live.status()).toEqual({ provider: 'azure', problem: null, image: null });
    expect(live.current()).toBe(live.maybe());
  });

  it('is rebuilt only when the setup changes', async () => {
    let stored = row();
    const live = host(async () => stored);
    await live.reload();
    const first = live.current();
    await live.reload();
    expect(live.current()).toBe(first);
    stored = row({
      settings: {
        provider: 'azure',
        callbackUrl: 'https://o.internal',
        azure: AZURE,
        idleSuspendMinutes: 5,
      },
    });
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

describe('Test connection with a test sandbox', () => {
  /** A sandbox group that makes one sandbox, running at once, and removes it. */
  function makingGroup() {
    const created: AzureCreateRequest[] = [];
    const deleted: string[] = [];
    const client: AzureSandboxClient = {
      ...azureClient(),
      get: async (sandboxId) => ({
        id: sandboxId,
        state: 'Running',
        ports: [{ port: 8092, url: `https://${sandboxId}--8092.eastus2.adcproxy.io` }],
      }),
      beginCreate: (body) => {
        created.push(body);
        return { pollUntilDone: async () => ({ id: 'az-1', state: 'Running' }) };
      },
      delete: async (sandboxId) => {
        deleted.push(sandboxId);
      },
    };
    return { client, created, deleted };
  }

  it('makes a sandbox from the disk image, as every sandbox is made, waits for its worker, and removes it', async () => {
    const group = makingGroup();
    const trials = new TrialSandboxes('master');
    const probed: string[] = [];
    const tried = await checkStored(
      row(),
      { azureClient: async () => group.client },
      {
        trials,
        masterKey: 'master',
        newId: () => 'trial-1',
        // The worker boots: it fetches its environment, then answers.
        probe: async (address) => {
          probed.push(address);
          trials.sealedEnvironment('trial-1');
          return { status: 200 };
        },
      }
    );
    expect(tried.ok).toBe(true);
    expect(tried.detail).toMatch(
      /^Reached the sandbox group "renkei-sandbox-group" in PRD_INFRA \(eastus2\)\. Made a test sandbox from the disk image "renkei-sandbox" in renkei-sandbox-group/
    );
    expect(group.created[0]?.sourcesRef).toEqual({ diskImage: { id: 'renkei-sandbox' } });
    expect(group.created[0]?.environment.SANDBOX_ORCHESTRATOR_CALLBACK_URL).toBe(
      'https://orchestrator.internal:8097'
    );
    expect(probed).toEqual(['https://az-1--8092.eastus2.adcproxy.io']);
    expect(group.deleted).toEqual(['az-1']);
  });
});

describe('the disk image for this build', () => {
  const SHA = '12112db66f6bdd6fd42846039b8b9e9432136eb7';
  const BASE = `docker.io/scotteremiaroden/renkei-sandbox:${SHA}`;
  const automatic = (): StoredRow =>
    row({
      settings: {
        provider: 'azure',
        callbackUrl: 'https://orchestrator.internal:8097',
        azure: { ...AZURE, diskImage: '' },
        envNames: [],
      },
    });
  const silent = { info: () => undefined, warn: () => undefined, error: () => undefined };

  /** A group whose disk images build to `outcome` once `finish()` is called. */
  function imageGroup(outcome: 'Ready' | 'Failed' = 'Ready') {
    const images: DiskImageView[] = [];
    const created: string[] = [];
    let done = false;
    const diskImages: DiskImageClient = {
      list: async () => images.map((image) => ({ ...image })),
      get: async (id) => {
        const image = images.find((candidate) => candidate.id === id);
        if (!image) return null;
        if (done) image.state = outcome;
        return { ...image, message: image.state === 'Failed' ? 'manifest unknown' : null };
      },
      create: async (base, name) => {
        created.push(base);
        const id = `img-${created.length}`;
        images.push({ id, name, base, state: 'Building', message: null });
        return id;
      },
    };
    const client: AzureSandboxClient = { ...azureClient(), diskImages };
    return {
      client,
      created,
      finish: () => {
        done = true;
      },
      reset: () => {
        done = false;
        outcome = 'Ready';
      },
    };
  }

  /** Until `ready()` holds, letting the preparation's timers and promises run. */
  async function until(ready: () => boolean): Promise<void> {
    for (let i = 0; i < 200 && !ready(); i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(ready()).toBe(true);
  }

  beforeEach(() => registerDataStore(createMemoryDataStore()));
  afterEach(() => resetDataStore());

  it('is built from the sandbox image at this commit before any sandbox is made, and callers are told it is starting', async () => {
    const group = imageGroup();
    const preparer = new DiskImagePreparer();
    const live = new OrchestratorHost({
      read: async () => automatic(),
      masterKey: 'master',
      logger: silent,
      deps: { azureClient: async () => group.client },
      image: { preparer, commit: SHA, pollMs: 5 },
    });
    await live.reload();
    expect(live.maybe()).toBeNull();
    expect(() => live.current()).toThrow(/disk image for build 12112db is being prepared/);
    // A caller is told to try again shortly, not that sandboxes are broken.
    const refusal = (() => {
      try {
        live.current();
        return null;
      } catch (error) {
        return error;
      }
    })();
    expect(refusal instanceof OrchestratorError && refusal.type).toBe('starting');
    await until(() => live.status().image?.diskImageId === 'img-1');
    expect(group.created).toEqual([BASE]);
    expect(live.status().image).toMatchObject({ state: 'preparing', build: '12112db', base: BASE });

    group.finish();
    await until(() => live.maybe() !== null);
    expect(live.status()).toEqual({
      provider: 'azure',
      problem: null,
      image: { build: '12112db', base: BASE, state: 'ready', diskImageId: 'img-1', detail: null },
    });
  });

  it('is reused on a restart: a group that already has it Ready is in force at once', async () => {
    const group = imageGroup();
    group.finish();
    await group.client.diskImages?.create(BASE, 'renkei-sandbox-12112db66f6b');
    const live = new OrchestratorHost({
      read: async () => automatic(),
      masterKey: 'master',
      logger: silent,
      deps: { azureClient: async () => group.client },
      image: { preparer: new DiskImagePreparer(), commit: SHA, pollMs: 5 },
    });
    await live.reload();
    await until(() => live.maybe() !== null);
    expect(group.created).toEqual([BASE]);
  });

  it('that fails makes nothing, says why, and is prepared again when an operator asks', async () => {
    const group = imageGroup('Failed');
    group.finish();
    const live = new OrchestratorHost({
      read: async () => automatic(),
      masterKey: 'master',
      logger: silent,
      deps: { azureClient: async () => group.client },
      image: { preparer: new DiskImagePreparer(), commit: SHA, pollMs: 5 },
    });
    await live.reload();
    await until(() => live.status().image?.state === 'failed');
    await until(() => /could not be prepared/.test(live.status().problem ?? ''));
    expect(live.status().problem).toMatch(
      /manifest unknown; prepare it again from Organization → Sandboxes/
    );
    expect(live.maybe()).toBeNull();

    group.reset();
    const after = await live.prepareAgain();
    expect(after.image?.state).toBe('preparing');
    group.finish();
    await until(() => live.maybe() !== null);
    expect(group.created).toHaveLength(2);
  });

  it('cannot be had by a build that does not know its commit, and says to pin one', async () => {
    const live = new OrchestratorHost({
      read: async () => automatic(),
      masterKey: 'master',
      logger: silent,
      deps: { azureClient: async () => imageGroup().client },
      image: { preparer: new DiskImagePreparer(), commit: null },
    });
    await live.reload();
    expect(live.status().problem).toMatch(/built without its commit .* enter a disk image id/);
  });

  it('is what Test connection waits on, and says so when it is still being built', async () => {
    const group = imageGroup();
    const preparer = new DiskImagePreparer();
    const tried = await checkStored(
      automatic(),
      { azureClient: async () => group.client },
      { trials: new TrialSandboxes('master'), masterKey: 'master', newId: () => 'trial-1' },
      { preparer, commit: SHA, testWaitMs: 20, pollMs: 5 }
    );
    expect(tried.ok).toBe(false);
    expect(tried.detail).toMatch(
      /^Reached the sandbox group .* The disk image for build 12112db is being built from docker\.io\/scotteremiaroden\/renkei-sandbox:12112db66f6b.* Press Test connection again once it is ready\.$/
    );
    expect(group.created).toEqual([BASE]);
    // The build carries on after the answer; it ends Ready, nothing left polling.
    group.finish();
    await until(
      () =>
        preparer.status(`${AZURE.subscriptionId}/PRD_INFRA/renkei-sandbox-group|${BASE}`)?.state ===
        'ready'
    );
  });
});
