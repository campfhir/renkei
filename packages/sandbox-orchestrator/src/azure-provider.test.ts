import {
  AzureSandboxProvider,
  azureState,
  type AzureCreateRequest,
  type AzureSandbox,
  type AzureSandboxClient,
} from './azure-provider';

function notFound(): Error {
  return Object.assign(new Error('not found'), { statusCode: 404 });
}

/** A sandbox group in memory, speaking the part of the SDK the provider calls. */
function group() {
  const sandboxes = new Map<string, AzureSandbox>();
  const created: AzureCreateRequest[] = [];
  const listed: Array<Record<string, string> | undefined> = [];
  let made = 0;
  const need = (id: string): AzureSandbox => {
    const found = sandboxes.get(id);
    if (!found) throw notFound();
    return found;
  };
  const client: AzureSandboxClient = {
    get: async (id) => need(id),
    list: (options) => {
      listed.push(options?.labels);
      return (async function* () {
        yield* sandboxes.values();
      })();
    },
    beginCreate: (body) => ({
      pollUntilDone: async () => {
        created.push(body);
        made += 1;
        const sandbox: AzureSandbox = {
          id: `az-${made}`,
          state: 'Running',
          labels: body.labels,
          ports: [{ port: 8092, url: `https://az-${made}-8092.example.azure/` }],
          createdAt: '2026-01-01T00:00:00Z',
        };
        sandboxes.set(sandbox.id, sandbox);
        return sandbox;
      },
    }),
    delete: async (id) => {
      need(id);
      sandboxes.delete(id);
    },
    beginStop: (id) => ({
      pollUntilDone: async () => {
        need(id).state = 'Stopped';
      },
    }),
    beginResume: (id) => ({
      pollUntilDone: async () => {
        need(id).state = 'Running';
      },
    }),
  };
  return { client, sandboxes, created, listed };
}

const base = {
  diskImage: 'renkei-sandbox',
  cpu: '2000m',
  memory: '4096Mi',
  disk: '40Gi',
  suspendMode: 'Memory' as const,
  deployment: 'prod',
};

const spec = {
  sandboxId: 'sbx-1',
  kind: 'agent' as const,
  env: { A: '1' },
  idleSuspendSeconds: 900,
  idleDeleteSeconds: 86_400,
};

describe('the Azure provider', () => {
  it('creates a sandbox from the disk image with the worker’s port exposed and the platform’s idle rules as a backstop', async () => {
    const { client, created } = group();
    const provider = new AzureSandboxProvider({
      ...base,
      vnetConnection: 'private',
      allowedCidrs: ['10.0.0.0/8'],
      client,
    });
    expect(await provider.create(spec)).toEqual({ providerId: 'az-1' });
    expect(created[0]).toEqual({
      sourcesRef: { diskImage: { name: 'renkei-sandbox', isPublic: false } },
      resources: { cpu: '2000m', memory: '4096Mi', disk: '40Gi' },
      lifecycle: {
        autoSuspend: { enabled: true, interval: 1800, mode: 'Memory' },
        autoDelete: { enabled: true, deleteIntervalSeconds: 172_800 },
      },
      labels: {
        'renkei-orchestrator': 'prod',
        'renkei-sandbox-id': 'sbx-1',
        'renkei-kind': 'agent',
      },
      environment: { A: '1' },
      ports: [
        {
          port: 8092,
          auth: { anonymous: true },
          protocol: 'Http',
          ipAccessControl: {
            defaultAction: 'Deny',
            rules: [
              { name: 'callers', action: 'Allow', priority: 100, sourceCidrs: ['10.0.0.0/8'] },
            ],
          },
        },
      ],
      customerVnetConnectionName: 'private',
    });
  });

  it('says where a running sandbox answers: its port’s URL', async () => {
    const { client } = group();
    const provider = new AzureSandboxProvider({ ...base, client });
    await provider.create(spec);
    expect(await provider.inspect('az-1')).toEqual({
      providerId: 'az-1',
      state: 'running',
      address: 'https://az-1-8092.example.azure',
      sandboxId: 'sbx-1',
      createdAt: new Date('2026-01-01T00:00:00Z'),
    });
    expect(await provider.inspect('az-9')).toBeNull();
  });

  it('suspends, resumes and removes, and is content when a sandbox is already where it was asked to be', async () => {
    const { client, sandboxes } = group();
    const provider = new AzureSandboxProvider({ ...base, client });
    await provider.create(spec);
    await provider.suspend('az-1');
    expect(await provider.inspect('az-1')).toMatchObject({ state: 'suspended', address: null });
    await provider.resume('az-1');
    expect((await provider.inspect('az-1'))?.state).toBe('running');
    await provider.destroy('az-1');
    await provider.destroy('az-1');
    expect(sandboxes.size).toBe(0);
  });

  it('lists this deployment’s sandboxes, leaving out those on their way out', async () => {
    const { client, sandboxes, listed } = group();
    const provider = new AzureSandboxProvider({ ...base, client });
    await provider.create(spec);
    sandboxes.set('az-x', { id: 'az-x', state: 'Deleting', labels: {} });
    expect((await provider.list()).map((sandbox) => sandbox.providerId)).toEqual(['az-1']);
    expect(listed[0]).toEqual({ 'renkei-orchestrator': 'prod' });
  });

  it('reads the platform’s states', () => {
    expect(azureState('Running')).toBe('running');
    expect(azureState('Idle')).toBe('running');
    expect(azureState('Creating')).toBe('starting');
    expect(azureState('Resuming')).toBe('starting');
    expect(azureState('Stopping')).toBe('stopping');
    expect(azureState('Stopped')).toBe('suspended');
    expect(azureState('Suspended')).toBe('suspended');
    expect(azureState('Deleting')).toBeNull();
    expect(azureState('Disabled')).toBe('failed');
    expect(azureState(undefined)).toBe('failed');
  });
});
