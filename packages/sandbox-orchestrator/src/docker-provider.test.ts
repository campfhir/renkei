import type { EngineResponse, EngineTransport } from './docker-engine';
import { DockerSandboxProvider, dockerState } from './docker-provider';

type Handler = (body: unknown) => { status: number; body?: unknown };

/** A scripted engine: each `METHOD path-prefix` answers what the test says. */
function engine(routes: Record<string, Handler>) {
  const calls: Array<{ method: string; path: string; body: unknown }> = [];
  const transport: EngineTransport = {
    async call(method, path, input = {}): Promise<EngineResponse> {
      calls.push({ method, path, body: input.body });
      const match = Object.keys(routes)
        .filter((key) => `${method} ${path}`.startsWith(key))
        .sort((a, b) => b.length - a.length)[0];
      if (!match) return { status: 404, body: Buffer.from('{"message":"no such route"}') };
      const answer = routes[match]!(input.body);
      return {
        status: answer.status,
        body: Buffer.from(answer.body === undefined ? '' : JSON.stringify(answer.body)),
      };
    },
  };
  return { transport, calls };
}

const base = {
  image: 'renkei-sandbox:test',
  networks: ['renkei-sandbox', 'renkei-sandbox-db'],
  memoryBytes: 1024,
  shmBytes: 512,
  pidsLimit: 100,
  cpus: 2,
  suspend: 'stop' as const,
  deployment: 'test',
};

const spec = {
  sandboxId: 'sbx-1',
  kind: 'user' as const,
  env: { A: '1' },
  idleSuspendSeconds: 900,
  idleDeleteSeconds: 86_400,
};

describe('the Docker provider', () => {
  it('makes a locked-down container from the sandbox image, joins its networks and starts it', async () => {
    const { transport, calls } = engine({
      'POST /containers/create': () => ({ status: 201, body: { Id: 'c1' } }),
      'POST /networks/renkei-sandbox-db/connect': () => ({ status: 200 }),
      'POST /containers/c1/start': () => ({ status: 204 }),
    });
    const provider = new DockerSandboxProvider({ ...base, transport });
    expect(await provider.create(spec)).toEqual({ providerId: 'c1' });
    expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      'POST /containers/create?name=renkei-sandbox-sbx-1',
      'POST /networks/renkei-sandbox-db/connect',
      'POST /containers/c1/start',
    ]);
    expect(calls[0]!.body).toMatchObject({
      Image: 'renkei-sandbox:test',
      Env: ['A=1'],
      Labels: {
        'renkei.orchestrator.sandbox': '1',
        'renkei.orchestrator.sandbox-id': 'sbx-1',
        'renkei.orchestrator.kind': 'user',
        'renkei.orchestrator.deployment': 'test',
      },
      HostConfig: {
        NetworkMode: 'renkei-sandbox',
        Memory: 1024,
        MemorySwap: 1024,
        ShmSize: 512,
        PidsLimit: 100,
        NanoCpus: 2_000_000_000,
        SecurityOpt: ['no-new-privileges:true'],
        CapDrop: ['ALL'],
        RestartPolicy: { Name: 'no' },
      },
    });
    // No way to the engine from inside: nothing is mounted.
    expect(JSON.stringify(calls[0]!.body)).not.toContain('docker.sock');
  });

  it('removes what it made when the container will not start', async () => {
    const { transport, calls } = engine({
      'POST /containers/create': () => ({ status: 201, body: { Id: 'c1' } }),
      'POST /networks/': () => ({ status: 200 }),
      'POST /containers/c1/start': () => ({ status: 500, body: { message: 'no such image' } }),
      'DELETE /containers/c1': () => ({ status: 204 }),
    });
    const provider = new DockerSandboxProvider({ ...base, transport });
    await expect(provider.create(spec)).rejects.toMatchObject({ message: 'no such image' });
    expect(calls.at(-1)).toMatchObject({ method: 'DELETE', path: '/containers/c1?v=1&force=1' });
  });

  it('says where a running sandbox answers: its address on the first network', async () => {
    const { transport } = engine({
      'GET /containers/c1/json': () => ({
        status: 200,
        body: {
          Id: 'c1',
          Created: '2026-01-01T00:00:00Z',
          State: { Status: 'running', Running: true },
          Config: { Labels: { 'renkei.orchestrator.sandbox-id': 'sbx-1' } },
          NetworkSettings: {
            Networks: {
              'renkei-sandbox': { IPAddress: '172.20.0.9' },
              'renkei-sandbox-db': { IPAddress: '172.21.0.9' },
            },
          },
        },
      }),
    });
    const provider = new DockerSandboxProvider({ ...base, transport });
    expect(await provider.inspect('c1')).toEqual({
      providerId: 'c1',
      state: 'running',
      address: 'http://172.20.0.9:8092',
      sandboxId: 'sbx-1',
      createdAt: new Date('2026-01-01T00:00:00Z'),
    });
    expect(await provider.inspect('nope')).toBeNull();
  });

  it('answers a loopback port instead when told to publish', async () => {
    const { transport, calls } = engine({
      'POST /containers/create': () => ({ status: 201, body: { Id: 'c1' } }),
      'POST /containers/c1/start': () => ({ status: 204 }),
      'GET /containers/c1/json': () => ({
        status: 200,
        body: {
          Id: 'c1',
          State: { Status: 'running', Running: true },
          NetworkSettings: { Ports: { '8092/tcp': [{ HostIp: '127.0.0.1', HostPort: '49153' }] } },
        },
      }),
    });
    const provider = new DockerSandboxProvider({
      ...base,
      networks: [],
      publishHost: '127.0.0.1',
      transport,
    });
    await provider.create(spec);
    expect(calls[0]!.body).toMatchObject({
      HostConfig: { PortBindings: { '8092/tcp': [{ HostIp: '127.0.0.1', HostPort: '' }] } },
    });
    expect((await provider.inspect('c1'))?.address).toBe('http://127.0.0.1:49153');
  });

  it('suspends by stopping (the disk stays) and resumes by starting', async () => {
    const { transport, calls } = engine({
      'POST /containers/c1/stop': () => ({ status: 204 }),
      'GET /containers/c1/json': () => ({ status: 200, body: { State: { Status: 'exited' } } }),
      'POST /containers/c1/start': () => ({ status: 204 }),
    });
    const provider = new DockerSandboxProvider({ ...base, transport });
    await provider.suspend('c1');
    await provider.resume('c1');
    expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      'POST /containers/c1/stop?t=25',
      'GET /containers/c1/json',
      'POST /containers/c1/start',
    ]);
  });

  it('pauses and unpauses when the deployment keeps memory across a suspend', async () => {
    const { transport, calls } = engine({
      'POST /containers/c1/pause': () => ({ status: 204 }),
      'GET /containers/c1/json': () => ({
        status: 200,
        body: { State: { Status: 'paused', Running: true, Paused: true } },
      }),
      'POST /containers/c1/unpause': () => ({ status: 204 }),
    });
    const provider = new DockerSandboxProvider({ ...base, suspend: 'pause', transport });
    await provider.suspend('c1');
    await provider.resume('c1');
    expect(calls.map((call) => call.path)).toEqual([
      '/containers/c1/pause',
      '/containers/c1/json',
      '/containers/c1/unpause',
    ]);
  });

  it('removes a sandbox with its volumes, and is content when it is already gone', async () => {
    const { transport, calls } = engine({});
    const provider = new DockerSandboxProvider({ ...base, transport });
    await provider.destroy('c1');
    expect(calls[0]).toMatchObject({ method: 'DELETE', path: '/containers/c1?v=1&force=1' });
  });

  it('lists only this deployment’s sandboxes', async () => {
    const { transport, calls } = engine({
      'GET /containers/json': () => ({
        status: 200,
        body: [
          {
            Id: 'c1',
            State: 'exited',
            Created: 1_767_225_600,
            Labels: { 'renkei.orchestrator.sandbox-id': 'sbx-1' },
          },
        ],
      }),
    });
    const provider = new DockerSandboxProvider({ ...base, transport });
    expect(await provider.list()).toEqual([
      {
        providerId: 'c1',
        state: 'suspended',
        address: null,
        sandboxId: 'sbx-1',
        createdAt: new Date('2026-01-01T00:00:00Z'),
      },
    ]);
    const filters = new URLSearchParams(calls[0]!.path.split('?')[1]).get('filters');
    expect(JSON.parse(filters ?? '{}')).toEqual({
      label: ['renkei.orchestrator.sandbox=1', 'renkei.orchestrator.deployment=test'],
    });
  });

  it('refuses to start without the sandbox image on the engine', async () => {
    const { transport } = engine({ 'GET /version': () => ({ status: 200, body: {} }) });
    const provider = new DockerSandboxProvider({ ...base, transport });
    await expect(provider.check()).rejects.toThrow(/renkei-sandbox:test is not on the engine/);
  });

  it('reads the engine’s states', () => {
    expect(dockerState({ Status: 'running', Running: true })).toBe('running');
    expect(dockerState({ Status: 'paused', Running: true, Paused: true })).toBe('suspended');
    expect(dockerState({ Status: 'exited' })).toBe('suspended');
    expect(dockerState({ Status: 'created' })).toBe('suspended');
    expect(dockerState({ Status: 'restarting', Restarting: true })).toBe('starting');
    expect(dockerState({ Status: 'dead', Dead: true })).toBe('failed');
  });
});
