/* eslint-disable @typescript-eslint/consistent-type-assertions, @typescript-eslint/no-explicit-any */
/**
 * The service verbs over the wire against a scripted engine: closed when
 * not enabled, an image outside the organization's rules refused before
 * anything is pulled, an allowed one pulled with its registry's
 * credential and started as a plain container on the services network,
 * its address announced to the project's commands (and winning over the
 * `.env`), a container that dies at once reported with its last lines,
 * a stop that removes it, and a rule's secret sealed and never echoed.
 */

jest.mock('./service-store', () => {
  const rows = new Map<string, any>();
  return {
    __rows: rows,
    insertService: jest.fn(async (_db: unknown, input: any) => {
      const row = {
        id: `svc-${rows.size + 1}`,
        tenantId: input.tenantId,
        subject: input.subject,
        name: input.name,
        image: input.image,
        containerId: null,
        status: 'starting',
        error: null,
        host: null,
        ports: [],
        exports: input.exports,
        exportNames: Object.keys(input.exports).sort(),
        createdAt: new Date(),
        lastUsedAt: new Date(),
        expiresAt: new Date(Date.now() + 60_000),
      };
      rows.set(row.id, row);
      return { ...row };
    }),
    listServices: jest.fn(async (_db: unknown, target: any) =>
      [...rows.values()]
        .filter((row) => row.tenantId === target.tenantId && row.subject === target.subject)
        .map((row) => ({ ...row }))
    ),
    getServiceByName: jest.fn(async (_db: unknown, target: any, name: string) => {
      const row = [...rows.values()].find(
        (r) => r.tenantId === target.tenantId && r.subject === target.subject && r.name === name
      );
      return row ? { ...row } : undefined;
    }),
    updateService: jest.fn(async (_db: unknown, id: string, input: any) => {
      const row = rows.get(id);
      if (row) Object.assign(row, input);
    }),
    touchServices: jest.fn(async () => undefined),
    deleteServiceById: jest.fn(async (_db: unknown, id: string) => {
      rows.delete(id);
    }),
    listExpiredServices: jest.fn(async () => []),
    listClaimedContainerIds: jest.fn(
      async () => new Set([...rows.values()].map((r) => r.containerId))
    ),
  };
});

jest.mock('./image-rules-store', () => {
  const actual = jest.requireActual('./image-rules-store');
  return {
    ...actual,
    listImageRulesForMatching: jest.fn(),
    listImageRules: jest.fn(),
    countImageRules: jest.fn(async () => 0),
    insertImageRule: jest.fn(),
    updateImageRule: jest.fn(),
    deleteImageRule: jest.fn(),
    restoreDefaultImageRules: jest.fn(async () => 0),
  };
});

jest.mock('./workspace-store', () => ({
  getWorkspace: jest.fn(),
  listWorkspaces: jest.fn(),
  countWorkspaces: jest.fn(),
  insertWorkspace: jest.fn(),
  setWorkspaceStatus: jest.fn(),
  touchWorkspace: jest.fn(),
  deleteWorkspace: jest.fn(),
  listExpiredWorkspaces: jest.fn(),
  deleteWorkspaceById: jest.fn(),
}));

jest.mock('./env-secrets-store', () => ({
  listSealedEnv: jest.fn(),
  touchEnvSecretsUsed: jest.fn(),
  listEnvSecrets: jest.fn(),
  countEnvSecrets: jest.fn(),
  hasEnvSecret: jest.fn(),
  upsertEnvSecret: jest.fn(),
  deleteEnvSecret: jest.fn(),
}));

import { mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Kysely } from 'kysely';
import type { DB } from '@renkei/db';
import { createSandboxServer } from './server';
import type { ContainerSpec, ContainerState, DockerEngine } from './docker';
import { ServiceManager } from './services';
import { openRegistrySecret, sealRegistrySecret } from './image-rules-store';
import { resetEnvSecretsKeyForTests, envSecretsKey, sealEnvValue } from './env-secrets';
import { setWorkspacesRootForTests, workspaceDir } from './workspaces';

const serviceStore = jest.requireMock<Record<string, any>>('./service-store');
const ruleStore = jest.requireMock<Record<string, jest.Mock>>('./image-rules-store');
const workspaceStore = jest.requireMock<Record<string, jest.Mock>>('./workspace-store');
const envStore = jest.requireMock<Record<string, jest.Mock>>('./env-secrets-store');

const API_KEY = 'test-worker-key';
const TARGET = { tenantId: 'tenant-1', subject: 'code-project:p1' };
const NETWORK = 'renkei-sandbox-services';
const STORAGE_KEY = 'tenant-1/hash/ws-1';

/** A scripted engine: what was asked of it, and what it answers. */
function scriptedEngine() {
  const calls: Array<{ op: string; args: unknown[] }> = [];
  const containers = new Map<
    string,
    { spec: ContainerSpec; running: boolean; exitCode: number | null }
  >();
  let nextId = 1;
  const engine: DockerEngine & {
    calls: typeof calls;
    containers: typeof containers;
    dieOnStart: boolean;
    logs: string;
    reset(): void;
  } = {
    calls,
    containers,
    dieOnStart: false,
    logs: 'FATAL: password not set\n',
    reset() {
      calls.length = 0;
      containers.clear();
      nextId = 1;
      engine.dieOnStart = false;
      engine.logs = 'FATAL: password not set\n';
    },
    async version() {
      calls.push({ op: 'version', args: [] });
      return { version: '27.0', apiVersion: '1.47' };
    },
    async pullImage(repository, tag, auth, timeoutMs) {
      calls.push({ op: 'pull', args: [repository, tag, auth, timeoutMs] });
    },
    async imagePorts(reference) {
      calls.push({ op: 'ports', args: [reference] });
      return reference.includes('postgres') ? [5432] : [];
    },
    async ensureNetwork(name) {
      calls.push({ op: 'network', args: [name] });
    },
    async connectToNetwork(network, container) {
      calls.push({ op: 'connect', args: [network, container] });
    },
    async createContainer(spec) {
      calls.push({ op: 'create', args: [spec] });
      const id = `c${nextId++}`;
      containers.set(id, { spec, running: false, exitCode: null });
      return id;
    },
    async startContainer(id) {
      calls.push({ op: 'start', args: [id] });
      const container = containers.get(id)!;
      if (engine.dieOnStart) {
        container.running = false;
        container.exitCode = 1;
      } else {
        container.running = true;
      }
    },
    async inspectContainer(id, network): Promise<ContainerState | null> {
      const container = containers.get(id);
      if (!container) return null;
      return {
        id,
        running: container.running,
        status: container.running ? 'running' : 'exited',
        exitCode: container.exitCode,
        ip: container.running && network === NETWORK ? `172.20.0.${id.slice(1)}` : null,
      };
    },
    async containerLogs(id, tail, options) {
      calls.push({ op: 'logs', args: [id, tail, ...(options ? [options] : [])] });
      if (options?.timestamps) {
        const name = containers.get(id)?.spec.labels['renkei.sandbox.name'] ?? id;
        const base = name === 'db' ? 0 : 1;
        const stamped = [
          `2026-09-23T10:00:0${base}.000000000Z ${name} starting`,
          `2026-09-23T10:00:0${base + 2}.500000000Z ${name} ready`,
          `2026-09-23T10:00:0${base + 4}.000000000Z ERROR: ${name} lost a connection`,
        ];
        // The engine's since is seconds.nanos; compared against each stamp's own seconds.
        const sinceSeconds = options.since ? Number(options.since) : null;
        return stamped
          .filter(
            (line) => sinceSeconds === null || Date.parse(line.slice(0, 30)) / 1000 > sinceSeconds
          )
          .join('\n');
      }
      return engine.logs;
    },
    async stopContainer(id, timeout) {
      calls.push({ op: 'stop', args: [id, timeout] });
      const container = containers.get(id);
      if (container) container.running = false;
    },
    async removeContainer(id) {
      calls.push({ op: 'remove', args: [id] });
      containers.delete(id);
    },
    async listContainers() {
      return [...containers.keys()].map((id) => ({ id, labels: containers.get(id)!.spec.labels }));
    },
  };
  return engine;
}

let engine: ReturnType<typeof scriptedEngine>;
let manager: ServiceManager;
let enabledServer: Server;
let disabledServer: Server;
let enabledBase: string;
let disabledBase: string;

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function post(
  base: string,
  op: string,
  body: unknown
): Promise<{ status: number; json: any }> {
  const response = await fetch(`${base}/v1/${op}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${API_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: response.status, json: await response.json() };
}

const RULES = [
  {
    id: 'r-pg',
    pattern: 'docker.io/library/postgres',
    registryUsername: null,
    registrySealed: null,
  },
  { id: 'r-acr', pattern: 'myorg.azurecr.io', registryUsername: null, registrySealed: null },
];

function readyWorkspace() {
  return {
    id: 'ws-1',
    tenantId: TARGET.tenantId,
    subject: TARGET.subject,
    provider: 'atlassian-bitbucket',
    repoFullName: 'acme/demo',
    branch: 'main',
    storageKey: STORAGE_KEY,
    status: 'ready',
    error: null,
    sizeBytes: 10,
    createdAt: new Date(),
    lastUsedAt: new Date(),
    expiresAt: new Date(Date.now() + 60_000),
  };
}

beforeAll(async () => {
  process.env.SANDBOX_ENV_SECRETS_KEY = Buffer.alloc(32, 7).toString('base64');
  resetEnvSecretsKeyForTests();
  const root = await mkdtemp(join(tmpdir(), 'renkei-svc-'));
  setWorkspacesRootForTests(root);
  await mkdir(workspaceDir(STORAGE_KEY), { recursive: true });
  await mkdir(join(root, 'tenant-1', 'hash', 'home'), { recursive: true });
  engine = scriptedEngine();
  manager = new ServiceManager({
    db: {} as Kysely<DB>,
    engine,
    network: NETWORK,
    selfContainer: 'self-1',
    memoryBytes: 1_073_741_824,
    pidsLimit: 512,
  });
  enabledServer = createSandboxServer({
    db: {} as Kysely<DB>,
    apiKeys: [API_KEY],
    browser: null,
    workspaces: true,
    services: manager,
  });
  disabledServer = createSandboxServer({
    db: {} as Kysely<DB>,
    apiKeys: [API_KEY],
    browser: null,
    workspaces: true,
  });
  enabledBase = await listen(enabledServer);
  disabledBase = await listen(disabledServer);
});

afterAll(async () => {
  await Promise.all([
    new Promise<void>((resolve) => enabledServer.close(() => resolve())),
    new Promise<void>((resolve) => disabledServer.close(() => resolve())),
  ]);
});

beforeEach(() => {
  engine.reset();
  serviceStore.__rows.clear();
  serviceStore.touchServices.mockClear();
  ruleStore.listImageRulesForMatching.mockResolvedValue(RULES);
  workspaceStore.getWorkspace.mockResolvedValue(readyWorkspace());
  workspaceStore.touchWorkspace.mockResolvedValue(undefined);
  envStore.listSealedEnv.mockResolvedValue([]);
  envStore.touchEnvSecretsUsed.mockResolvedValue(undefined);
});

describe('closed when not enabled', () => {
  it('every service verb answers 503', async () => {
    for (const op of ['services/list', 'services/start', 'services/rules/list']) {
      const { status, json } = await post(disabledBase, op, {
        ...TARGET,
        name: 'db',
        image: 'postgres',
      });
      expect(status).toBe(503);
      expect(json.error.type).toBe('services_unavailable');
    }
  });
});

describe('prepare', () => {
  it('checks the engine, makes the network and joins it', async () => {
    await manager.prepare();
    expect(engine.calls.map((call) => call.op)).toEqual(['version', 'network', 'connect']);
    expect(engine.calls[2]!.args).toEqual([NETWORK, 'self-1']);
  });
});

describe('start', () => {
  it('refuses an image outside the rules before pulling anything, naming what is allowed', async () => {
    const { status, json } = await post(enabledBase, 'services/start', {
      ...TARGET,
      name: 'cache',
      image: 'redis:7',
    });
    expect(status).toBe(403);
    expect(json.error.type).toBe('not_allowed');
    expect(json.error.message).toContain('docker.io/library/redis:7');
    expect(json.error.message).toContain('docker.io/library/postgres');
    expect(engine.calls).toEqual([]);
    expect(serviceStore.__rows.size).toBe(0);
  });

  it('refuses a bad name, env or exports', async () => {
    expect(
      (await post(enabledBase, 'services/start', { ...TARGET, name: 'DB', image: 'postgres' }))
        .status
    ).toBe(400);
    expect(
      (
        await post(enabledBase, 'services/start', {
          ...TARGET,
          name: 'db',
          image: 'postgres',
          env: { 'x y': '1' },
        })
      ).status
    ).toBe(400);
    expect(
      (
        await post(enabledBase, 'services/start', {
          ...TARGET,
          name: 'db',
          image: 'postgres',
          exports: { PATH: '/x' },
        })
      ).status
    ).toBe(400);
    expect(
      (await post(enabledBase, 'services/start', { ...TARGET, name: 'db', image: 'Bad Image' }))
        .status
    ).toBe(400);
  });

  it('pulls, creates a plain container on the network, starts it and answers its address', async () => {
    const { status, json } = await post(enabledBase, 'services/start', {
      ...TARGET,
      name: 'db',
      image: 'postgres:16',
      env: { POSTGRES_PASSWORD: 'pw', POSTGRES_DB: 'app' },
      exports: { DATABASE_URL: 'postgres://postgres:pw@{host}:{port}/app' },
    });
    expect(status).toBe(201);
    expect(json.service).toMatchObject({
      name: 'db',
      image: 'docker.io/library/postgres:16',
      status: 'running',
      host: '172.20.0.1',
      ports: [5432],
      exportNames: ['DATABASE_URL'],
    });
    const ops = engine.calls.map((call) => call.op);
    expect(ops).toEqual(['pull', 'ports', 'create', 'start']);
    expect(engine.calls[0]!.args.slice(0, 3)).toEqual(['docker.io/library/postgres', '16', null]);
    const spec = engine.calls[2]!.args[0] as ContainerSpec;
    expect(spec).toMatchObject({
      image: 'docker.io/library/postgres:16',
      env: { POSTGRES_PASSWORD: 'pw', POSTGRES_DB: 'app' },
      network: NETWORK,
      memoryBytes: 1_073_741_824,
      pidsLimit: 512,
    });
    expect(spec.name).toMatch(/^renkei-svc-/);
    expect(spec.labels['renkei.sandbox.service']).toBe('1');
    expect(spec.labels['renkei.sandbox.tenant']).toBe('tenant-1');
    expect(spec.labels['renkei.sandbox.name']).toBe('db');
    // The subject is labelled by its hash, never in the clear.
    expect(spec.labels['renkei.sandbox.subject']).not.toContain('code-project');
  });

  it('pulls a private registry image with its rule’s credential, never echoing it', async () => {
    const key = envSecretsKey()!;
    ruleStore.listImageRulesForMatching.mockResolvedValue([
      ...RULES.filter((rule) => rule.id !== 'r-acr'),
      {
        id: 'r-acr',
        pattern: 'myorg.azurecr.io',
        registryUsername: 'sp-pull',
        registrySealed: sealRegistrySecret('s3cret', key),
      },
      {
        id: 'r-ns',
        pattern: 'myorg.azurecr.io/platform/*',
        registryUsername: null,
        registrySealed: null,
      },
    ]);
    const { status, json } = await post(enabledBase, 'services/start', {
      ...TARGET,
      name: 'api',
      image: 'myorg.azurecr.io/platform/api:1.2',
    });
    expect(status).toBe(201);
    expect(JSON.stringify(json)).not.toContain('s3cret');
    // The namespace rule won the match; the registry rule lent its credential.
    expect(engine.calls[0]!.args).toEqual([
      'myorg.azurecr.io/platform/api',
      '1.2',
      { username: 'sp-pull', password: 's3cret', serveraddress: 'myorg.azurecr.io' },
      expect.any(Number),
    ]);
  });

  it('a second service under a running name is refused; a failed one makes way', async () => {
    await post(enabledBase, 'services/start', { ...TARGET, name: 'db', image: 'postgres' });
    const again = await post(enabledBase, 'services/start', {
      ...TARGET,
      name: 'db',
      image: 'postgres',
    });
    expect(again.status).toBe(409);
    expect(again.json.error.type).toBe('exists');
  });

  it('a container that dies at once is reported failed with its last lines, and removed', async () => {
    engine.dieOnStart = true;
    const { status, json } = await post(enabledBase, 'services/start', {
      ...TARGET,
      name: 'db',
      image: 'postgres',
    });
    expect(status).toBe(502);
    expect(json.error.type).toBe('engine');
    expect(json.error.message).toContain('exited right after starting (exit 1)');
    expect(json.error.message).toContain('FATAL: password not set');
    expect(engine.calls.map((call) => call.op)).toEqual([
      'pull',
      'ports',
      'create',
      'start',
      'logs',
      'remove',
    ]);
    const listed = await post(enabledBase, 'services/list', TARGET);
    expect(listed.json.services).toHaveLength(1);
    expect(listed.json.services[0]).toMatchObject({ name: 'db', status: 'failed' });
    // And the name is free again.
    engine.dieOnStart = false;
    const retry = await post(enabledBase, 'services/start', {
      ...TARGET,
      name: 'db',
      image: 'postgres',
    });
    expect(retry.status).toBe(201);
  });

  it('a pull that fails is reported, and nothing is created', async () => {
    const failing = jest
      .spyOn(engine, 'pullImage')
      .mockRejectedValueOnce(new Error('manifest unknown'));
    const { status, json } = await post(enabledBase, 'services/start', {
      ...TARGET,
      name: 'db',
      image: 'postgres:99',
    });
    failing.mockRestore();
    expect(status).toBe(502);
    expect(json.error.message).toContain('could not be pulled: manifest unknown');
    expect(engine.containers.size).toBe(0);
  });
});

describe('a running service and the project’s commands', () => {
  it('its address and exports are in a command’s environment, over the .env', async () => {
    envStore.listSealedEnv.mockResolvedValue([
      {
        id: 'e1',
        name: 'DATABASE_URL',
        sealed: sealEnvValue('postgres://real-production-db/app', envSecretsKey()!),
      },
    ]);
    await post(enabledBase, 'services/start', {
      ...TARGET,
      name: 'db',
      image: 'postgres:16',
      exports: { DATABASE_URL: 'postgres://postgres:pw@{host}:{port}/app' },
    });
    const ran = await post(enabledBase, 'workspaces/exec', {
      ...TARGET,
      id: 'ws-1',
      command: 'echo "$SERVICE_DB_HOST:$SERVICE_DB_PORT $DATABASE_URL"',
    });
    expect(ran.status).toBe(200);
    expect(ran.json.stdout.trim()).toBe(
      '172.20.0.1:5432 postgres://postgres:pw@172.20.0.1:5432/app'
    );
    expect(serviceStore.touchServices).toHaveBeenCalledWith(expect.anything(), ['svc-1']);
  });

  it('a service that stopped on its own drops out of the environment and reads stopped', async () => {
    await post(enabledBase, 'services/start', { ...TARGET, name: 'db', image: 'postgres' });
    engine.containers.get('c1')!.running = false;
    engine.containers.get('c1')!.exitCode = 137;
    const ran = await post(enabledBase, 'workspaces/exec', {
      ...TARGET,
      id: 'ws-1',
      command: 'echo "[$SERVICE_DB_HOST]"',
    });
    expect(ran.json.stdout.trim()).toBe('[]');
    const listed = await post(enabledBase, 'services/list', TARGET);
    expect(listed.json.services[0]).toMatchObject({ status: 'stopped', host: null });
    expect(listed.json.services[0].error).toContain('exit 137');
  });

  it('logs read the container’s tail, stamped; since and match narrow it; stop removes it and its row', async () => {
    await post(enabledBase, 'services/start', { ...TARGET, name: 'db', image: 'postgres' });
    const logs = await post(enabledBase, 'services/logs', { ...TARGET, name: 'db', lines: 50 });
    expect(logs.status).toBe(200);
    expect(logs.json.logs).toBe(
      '2026-09-23T10:00:00.000000000Z db starting\n2026-09-23T10:00:02.500000000Z db ready\n2026-09-23T10:00:04.000000000Z ERROR: db lost a connection'
    );
    expect(logs.json).toMatchObject({ count: 3, lastAt: '2026-09-23T10:00:04.000000000Z' });
    expect(engine.calls.at(-1)).toEqual({ op: 'logs', args: ['c1', 50, { timestamps: true }] });
    // Only the error, and only what came after a stamp from the last answer.
    const errors = await post(enabledBase, 'services/logs', {
      ...TARGET,
      name: 'db',
      match: 'error',
    });
    expect(errors.json.logs).toBe('2026-09-23T10:00:04.000000000Z ERROR: db lost a connection');
    expect(errors.json.count).toBe(1);
    const after = await post(enabledBase, 'services/logs', {
      ...TARGET,
      name: 'db',
      since: '2026-09-23T10:00:02.500000000Z',
    });
    expect(engine.calls.at(-1)).toEqual({
      op: 'logs',
      args: ['c1', 200, { timestamps: true, since: '1790157602.500000001' }],
    });
    expect(after.json.logs).toBe('2026-09-23T10:00:04.000000000Z ERROR: db lost a connection');
    // A duration is read back from now; a bad since or match is refused.
    await post(enabledBase, 'services/logs', { ...TARGET, name: 'db', since: '5m' });
    const asked = engine.calls.at(-1)!.args[2] as { since?: string };
    expect(Number(asked.since)).toBeGreaterThan(Date.now() / 1000 - 301);
    expect(
      (await post(enabledBase, 'services/logs', { ...TARGET, name: 'db', since: 'ages' })).status
    ).toBe(400);
    expect(
      (await post(enabledBase, 'services/logs', { ...TARGET, name: 'db', match: '(' })).status
    ).toBe(400);

    const stopped = await post(enabledBase, 'services/stop', { ...TARGET, name: 'db' });
    expect(stopped.status).toBe(200);
    expect(stopped.json.service.status).toBe('stopped');
    expect(engine.calls.slice(-2).map((call) => call.op)).toEqual(['stop', 'remove']);
    expect(engine.containers.size).toBe(0);
    expect((await post(enabledBase, 'services/list', TARGET)).json.services).toEqual([]);
    expect((await post(enabledBase, 'services/stop', { ...TARGET, name: 'db' })).status).toBe(404);
  });

  it('another project never sees it', async () => {
    await post(enabledBase, 'services/start', { ...TARGET, name: 'db', image: 'postgres' });
    const other = await post(enabledBase, 'services/list', {
      tenantId: 'tenant-1',
      subject: 'code-project:p2',
    });
    expect(other.json.services).toEqual([]);
  });
});

describe('tail', () => {
  it('interleaves every service’s stamped lines, and follows from a stamp', async () => {
    await post(enabledBase, 'services/start', { ...TARGET, name: 'db', image: 'postgres' });
    await post(enabledBase, 'services/start', { ...TARGET, name: 'cache', image: 'postgres' });
    const all = await post(enabledBase, 'services/tail', { ...TARGET });
    expect(all.status).toBe(200);
    expect(
      all.json.entries.map(
        (entry: { service: string; line: string }) => `${entry.service}: ${entry.line}`
      )
    ).toEqual([
      'db: db starting',
      'cache: cache starting',
      'db: db ready',
      'cache: cache ready',
      'db: ERROR: db lost a connection',
      'cache: ERROR: cache lost a connection',
    ]);
    const matched = await post(enabledBase, 'services/tail', { ...TARGET, match: '^error' });
    expect(matched.json.entries.map((entry: { line: string }) => entry.line)).toEqual([
      'ERROR: db lost a connection',
      'ERROR: cache lost a connection',
    ]);
    expect(all.json.truncated).toBe(false);
    expect(all.json.unreadable).toEqual([]);
    // Following: the engine is asked for lines after the last stamp, one nanosecond on.
    const since = all.json.entries.at(-1).at;
    await post(enabledBase, 'services/tail', { ...TARGET, since });
    const asked = engine.calls.filter((call) => call.op === 'logs').slice(-2);
    expect(
      asked.every(
        (call) =>
          call.args[2] && (call.args[2] as { since?: string }).since === '1790157605.000000001'
      )
    ).toBe(true);
    expect((await post(enabledBase, 'services/tail', { ...TARGET, since: 'nope' })).status).toBe(
      400
    );
  });
});

describe('rules', () => {
  it('a rule is normalized and its secret sealed, never returned', async () => {
    ruleStore.insertImageRule.mockImplementation(async (_db: unknown, input: any) => ({
      id: '11111111-1111-4111-8111-111111111111',
      pattern: input.pattern,
      note: input.note,
      registryUsername: input.registryUsername,
      createdAt: new Date(),
      updatedAt: new Date(),
    }));
    const { status, json } = await post(enabledBase, 'services/rules/set', {
      tenantId: 'tenant-1',
      pattern: 'MyOrg.azurecr.io/',
      note: 'Our registry',
      registryUsername: 'sp-pull',
      registrySecret: 'topsecret',
    });
    expect(status).toBe(201);
    expect(json.rule).toMatchObject({
      pattern: 'myorg.azurecr.io',
      note: 'Our registry',
      registryUsername: 'sp-pull',
    });
    expect(JSON.stringify(json)).not.toContain('topsecret');
    const stored = ruleStore.insertImageRule.mock.calls[0]![1];
    expect(stored.registrySealed).toMatch(/^reg1\./);
    expect(openRegistrySecret(stored.registrySealed, envSecretsKey()!)).toBe('topsecret');
  });

  it('a tag on a rule is dropped and said so; a lone username is refused', async () => {
    ruleStore.insertImageRule.mockImplementation(async (_db: unknown, input: any) => ({
      id: '22222222-2222-4222-8222-222222222222',
      pattern: input.pattern,
      note: null,
      registryUsername: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    }));
    const tagged = await post(enabledBase, 'services/rules/set', {
      tenantId: 'tenant-1',
      pattern: 'redis:7',
    });
    expect(tagged.status).toBe(201);
    expect(tagged.json).toMatchObject({
      rule: { pattern: 'docker.io/library/redis' },
      dropped: 'the tag 7',
    });
    const half = await post(enabledBase, 'services/rules/set', {
      tenantId: 'tenant-1',
      pattern: 'x.io',
      registryUsername: 'u',
    });
    expect(half.status).toBe(400);
    const bad = await post(enabledBase, 'services/rules/set', {
      tenantId: 'tenant-1',
      pattern: 'x.io/*/y',
    });
    expect(bad.status).toBe(400);
  });

  it('list, delete and restore go to the store', async () => {
    ruleStore.listImageRules.mockResolvedValue([]);
    expect((await post(enabledBase, 'services/rules/list', { tenantId: 'tenant-1' })).json).toEqual(
      { rules: [] }
    );
    ruleStore.deleteImageRule.mockResolvedValue(false);
    expect(
      (
        await post(enabledBase, 'services/rules/delete', {
          tenantId: 'tenant-1',
          id: '33333333-3333-4333-8333-333333333333',
        })
      ).status
    ).toBe(404);
    expect(
      (await post(enabledBase, 'services/rules/delete', { tenantId: 'tenant-1', id: 'nope' }))
        .status
    ).toBe(400);
    ruleStore.restoreDefaultImageRules.mockResolvedValue(3);
    expect(
      (await post(enabledBase, 'services/rules/restore', { tenantId: 'tenant-1' })).json.added
    ).toBe(3);
  });
});

describe('sweep', () => {
  it('removes a container of ours that no row claims', async () => {
    await post(enabledBase, 'services/start', { ...TARGET, name: 'db', image: 'postgres' });
    serviceStore.__rows.clear();
    await manager.sweep(10);
    expect(engine.calls.at(-1)).toEqual({ op: 'remove', args: ['c1'] });
    expect(engine.containers.size).toBe(0);
  });
});
