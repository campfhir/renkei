/* eslint-disable @typescript-eslint/consistent-type-assertions, @typescript-eslint/no-explicit-any */
/**
 * Previews over the wire, with a real server started in a real checkout:
 * a start that waits until the port answers and tells the process where
 * it is served, requests relayed through the session path and the share
 * token path (and nowhere else), the server's own output in the logs, a
 * command that dies at once reported as exited with its last lines, a
 * name in use refused, a stop that ends the process, and the sweep that
 * ends an idle one.
 */

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
  getWorkspaceById: jest.fn(),
  listWorktrees: jest.fn(),
  listWorktreesOf: jest.fn(),
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

import { execFileSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createSandboxServer } from './server';
import { ALL_ORG_FEATURES } from './features';
import { identityFor, setWorkspacesRootForTests, workspaceDir } from './workspaces';
import { PreviewManager, portAccepts } from './previews';
import { envSecretsKey, resetEnvSecretsKeyForTests, sealEnvValue } from './env-secrets';

const workspaceStore = jest.requireMock<Record<string, jest.Mock>>('./workspace-store');
const envStore = jest.requireMock<Record<string, jest.Mock>>('./env-secrets-store');

const API_KEY = 'test-worker-key';
const TARGET = { subject: 'code-project:preview' };
const STORAGE_KEY = 'tenant-1/hash/ws-preview';
const TOKEN = 'a'.repeat(43);

/**
 * A server that answers what the proxy must carry: the path and query,
 * the Host it saw, a body echoed back, a redirect to a path of its own,
 * and the environment the sandbox gave it. Plain Python so the dropped
 * uid finds it on the system PATH.
 */
const SERVER_PY = `
import os, sys
from http.server import BaseHTTPRequestHandler, HTTPServer

class H(BaseHTTPRequestHandler):
    def _send(self, code, body, headers=None):
        data = body.encode()
        self.send_response(code)
        for k, v in (headers or {}).items():
            self.send_header(k, v)
        self.send_header('Content-Type', 'text/plain')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)
    def do_GET(self):
        if self.path.startswith('/redir'):
            return self._send(302, '', {'Location': '/hello'})
        if self.path.startswith('/env'):
            return self._send(200, 'PORT=%s URL=%s SECRET=%s' % (os.environ.get('PORT'), os.environ.get('RENKEI_PREVIEW_URL'), os.environ.get('NPM_TOKEN')))
        if self.path.startswith('/neighbours'):
            return self._send(200, ' '.join('%s=%s' % (k, v) for k, v in sorted(os.environ.items()) if k.startswith('PREVIEW_')))
        return self._send(200, 'hi %s host=%s' % (self.path, self.headers.get('Host')))
    def do_POST(self):
        n = int(self.headers.get('Content-Length') or 0)
        return self._send(200, 'echo:' + self.rfile.read(n).decode())
    def log_message(self, fmt, *args):
        sys.stderr.write('served %s\\n' % (args[0] if args else ''))
        sys.stderr.flush()

print('listening on', os.environ['PORT'], flush=True)
HTTPServer(('0.0.0.0', int(os.environ['PORT'])), H).serve_forever()
`;

let root: string;
let server: Server;
let base: string;
let dir: string;
let manager: PreviewManager;

async function post(op: string, body: unknown): Promise<{ status: number; json: any }> {
  const response = await fetch(`${base}/v1/${op}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${API_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({ ...TARGET, id: 'ws-preview', ...(body as object) }),
  });
  return { status: response.status, json: await response.json() };
}

async function through(
  path: string,
  init: { method?: string; body?: string; subject?: string | null } = {}
): Promise<{ status: number; text: string; headers: Headers }> {
  const response = await fetch(`${base}${path}`, {
    method: init.method ?? 'GET',
    headers: {
      authorization: `Bearer ${API_KEY}`,
      ...(init.subject === null ? {} : { 'x-sandbox-subject': init.subject ?? TARGET.subject }),
    },
    ...(init.body !== undefined ? { body: init.body } : {}),
    redirect: 'manual',
  });
  return { status: response.status, text: await response.text(), headers: response.headers };
}

beforeAll(async () => {
  process.env.SANDBOX_ENV_SECRETS_KEY = Buffer.alloc(32, 9).toString('base64');
  resetEnvSecretsKeyForTests();
  root = await mkdtemp(join(tmpdir(), 'renkei-preview-'));
  setWorkspacesRootForTests(root);
  dir = workspaceDir(STORAGE_KEY);
  await mkdir(dir, { recursive: true });
  await mkdir(join(root, 'tenant-1', 'hash', 'home'), { recursive: true });
  for (const parent of [root, join(root, 'tenant-1'), join(root, 'tenant-1', 'hash')]) {
    await chmod(parent, 0o755);
  }
  await writeFile(join(dir, 'server.py'), SERVER_PY);
  const identity = identityFor(TARGET);
  if (identity) {
    execFileSync('chown', ['-R', `${identity.uid}:${identity.gid}`, dir], { stdio: 'pipe' });
  }
  manager = new PreviewManager();
  server = createSandboxServer({
    apiKeys: [API_KEY],
    workspaces: true,
    previews: manager,
    orgFeatures: async () => ALL_ORG_FEATURES,
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await manager.stopAll();
  await new Promise((resolve) => server.close(resolve));
  await rm(root, { recursive: true, force: true });
  delete process.env.SANDBOX_ENV_SECRETS_KEY;
  resetEnvSecretsKeyForTests();
});

beforeEach(() => {
  jest.clearAllMocks();
  workspaceStore.getWorkspace.mockImplementation(async (target: { subject: string }, id: string) =>
    target.subject === TARGET.subject && id === 'ws-preview'
      ? {
          id: 'ws-preview',
          subject: TARGET.subject,
          provider: 'github',
          repoFullName: 'acme/demo',
          branch: 'main',
          storageKey: STORAGE_KEY,
          parentId: null,
          status: 'ready',
          error: null,
          sizeBytes: 10,
          createdAt: new Date(),
          lastUsedAt: new Date(),
          expiresAt: new Date(Date.now() + 60_000),
        }
      : undefined
  );
  workspaceStore.touchWorkspace.mockResolvedValue(undefined);
  envStore.touchEnvSecretsUsed.mockResolvedValue(undefined);
  envStore.listSealedEnv.mockResolvedValue([
    { id: 'e1', name: 'NPM_TOKEN', sealed: sealEnvValue('tok-preview-secret', envSecretsKey()!) },
  ]);
});

describe('a preview', () => {
  it('starts in the checkout, is told where it is served, and is reached through the proxy', async () => {
    const started = await post('previews/start', {
      name: 'web',
      command: 'python3 server.py',
      url: 'https://app.example/api/code/projects/p1/previews/web/app/',
      waitMs: 30_000,
    });
    expect(started.status).toBe(201);
    expect(started.json.listening).toBe(true);
    expect(started.json.preview).toEqual(
      expect.objectContaining({
        name: 'web',
        status: 'running',
        token: null,
        workspaceId: 'ws-preview',
      })
    );
    const port: number = started.json.preview.port;
    expect(port).toBeGreaterThanOrEqual(20_000);
    expect(started.json.logs).toContain(`listening on ${port}`);

    const hello = await through('/v1/previews/proxy/web/hello/there?x=1');
    expect(hello.status).toBe(200);
    expect(hello.text).toBe(`hi /hello/there?x=1 host=127.0.0.1:${port}`);

    const env = await through('/v1/previews/proxy/web/env');
    expect(env.text).toBe(
      `PORT=${port} URL=https://app.example/api/code/projects/p1/previews/web/app/ SECRET=tok-preview-secret`
    );

    const echoed = await through('/v1/previews/proxy/web/post', {
      method: 'POST',
      body: 'payload',
    });
    expect(echoed.text).toBe('echo:payload');

    // A redirect to the server's own path is carried as it is; the web app
    // rewrites it under its prefix.
    const redirected = await through('/v1/previews/proxy/web/redir');
    expect(redirected.status).toBe(302);
    expect(redirected.headers.get('location')).toBe('/hello');

    // Another caller's name is nobody's; the public path needs a token.
    expect((await through('/v1/previews/proxy/web/hello', { subject: 'other' })).status).toBe(404);
    expect((await through('/v1/previews/proxy/web/hello', { subject: null })).status).toBe(404);
    expect((await through(`/v1/previews/public/${TOKEN}/hello`, { subject: null })).status).toBe(
      404
    );

    const logs = await post('previews/logs', { name: 'web', lines: 50 });
    expect(logs.status).toBe(200);
    expect(logs.json.logs).toContain('[stderr] served');
    expect(logs.json.preview.status).toBe('running');

    const listed = await post('previews/list', {});
    expect(listed.json.previews.map((p: any) => p.name)).toEqual(['web']);
    expect(listed.json.previews[0].command).toBe('python3 server.py');

    // The same name again is refused while it runs.
    const again = await post('previews/start', {
      name: 'web',
      command: 'python3 server.py',
      url: 'https://app.example/x/',
    });
    expect(again.status).toBe(409);
    expect(again.json.error.type).toBe('exists');

    const stopped = await post('previews/stop', { name: 'web' });
    expect(stopped.status).toBe(200);
    expect(await portAccepts(port)).toBe(false);
    expect((await post('previews/list', {})).json.previews).toEqual([]);
    expect((await through('/v1/previews/proxy/web/hello')).status).toBe(404);
  });

  it('tells a second preview, and a command, where the first one is', async () => {
    const api = await post('previews/start', {
      name: 'api',
      command: 'python3 server.py',
      url: 'https://app.example/api/code/projects/p1/previews/api/app/',
      waitMs: 30_000,
    });
    expect(api.status).toBe(201);
    const web = await post('previews/start', {
      name: 'web',
      command: 'python3 server.py',
      url: 'https://app.example/api/code/projects/p1/previews/web/app/',
      waitMs: 30_000,
    });
    expect(web.status).toBe(201);
    const seen = await through('/v1/previews/proxy/web/neighbours');
    expect(seen.text).toBe(
      `PREVIEW_API_PORT=${api.json.preview.port} PREVIEW_API_URL=https://app.example/api/code/projects/p1/previews/api/app/`
    );
    const ran = await post('workspaces/exec', { command: 'env | grep ^PREVIEW_ | sort' });
    expect(ran.status).toBe(200);
    expect(ran.json.stdout.trim().split('\n')).toEqual([
      `PREVIEW_API_PORT=${api.json.preview.port}`,
      'PREVIEW_API_URL=https://app.example/api/code/projects/p1/previews/api/app/',
      `PREVIEW_WEB_PORT=${web.json.preview.port}`,
      'PREVIEW_WEB_URL=https://app.example/api/code/projects/p1/previews/web/app/',
    ]);
    await post('previews/stop', { name: 'api' });
    await post('previews/stop', { name: 'web' });
  });

  it('is reached by its share token when started public, and nowhere else by token', async () => {
    const started = await post('previews/start', {
      name: 'pub',
      command: 'python3 server.py',
      token: TOKEN,
      url: `https://app.example/api/code/preview/${TOKEN}/`,
      waitMs: 30_000,
    });
    expect(started.status).toBe(201);
    expect(started.json.preview.token).toBe(TOKEN);
    const hello = await through(`/v1/previews/public/${TOKEN}/hello`, { subject: null });
    expect(hello.status).toBe(200);
    expect(hello.text).toContain('hi /hello');
    expect(
      (await through(`/v1/previews/public/${'b'.repeat(43)}/hello`, { subject: null })).status
    ).toBe(404);
    expect((await through('/v1/previews/public/short/hello', { subject: null })).status).toBe(404);
    await post('previews/stop', { name: 'pub' });
  });

  it('reports a command that exits at once as exited, with its last lines, and lets the name be reused', async () => {
    const started = await post('previews/start', {
      name: 'dead',
      command: 'echo "boom: no such port"; exit 3',
      url: 'https://app.example/x/',
      waitMs: 5_000,
    });
    expect(started.status).toBe(202);
    expect(started.json.listening).toBe(false);
    expect(started.json.preview.status).toBe('exited');
    expect(started.json.preview.exitCode).toBe(3);
    expect(started.json.logs).toContain('boom: no such port');
    expect(started.json.logs).toContain('exited with code 3');
    expect((await through('/v1/previews/proxy/dead/')).status).toBe(404);
    const replaced = await post('previews/start', {
      name: 'dead',
      command: 'exit 0',
      url: 'https://app.example/x/',
      waitMs: 2_000,
    });
    expect(replaced.status).toBe(202);
    expect(
      (await post('previews/list', {})).json.previews.filter((p: any) => p.name === 'dead')
    ).toHaveLength(1);
    await post('previews/stop', { name: 'dead' });
  });

  it('refuses a bad name, a privileged port, a bad url, and a token of the wrong shape', async () => {
    expect(
      (await post('previews/start', { name: 'Web', command: 'x', url: 'https://a/' })).status
    ).toBe(400);
    expect(
      (await post('previews/start', { name: 'web', command: 'x', port: 80, url: 'https://a/' }))
        .status
    ).toBe(400);
    expect((await post('previews/start', { name: 'web', command: 'x', url: 'nope' })).status).toBe(
      400
    );
    expect(
      (
        await post('previews/start', {
          name: 'web',
          command: 'x',
          url: 'https://a/',
          token: 'short',
        })
      ).status
    ).toBe(400);
    expect((await post('previews/logs', { name: 'nothing' })).status).toBe(404);
  });

  it('is swept once idle past its lifetime', async () => {
    const idle = new PreviewManager({ ttlMs: 0 });
    const identity = identityFor(TARGET);
    const started = await idle.start(TARGET, {
      workspace: {
        id: 'ws-preview',
        cwd: dir,
        home: join(root, 'tenant-1', 'hash', 'home'),
        identity,
      },
      name: 'idle',
      command: 'python3 server.py',
      port: null,
      env: {},
      extraEnv: {},
      token: null,
      url: 'https://app.example/x/',
      waitMs: 30_000,
    });
    expect(started.listening).toBe(true);
    expect(await idle.sweep(Date.now() + 1)).toBe(1);
    expect(await portAccepts(started.preview.port)).toBe(false);
    expect(idle.list(TARGET)).toEqual([]);
  });
});

describe('when workspaces are off', () => {
  it('answers every preview verb and the proxy 503', async () => {
    const closed = createSandboxServer({ apiKeys: [API_KEY] });
    await new Promise<void>((resolve) => closed.listen(0, '127.0.0.1', resolve));
    const closedBase = `http://127.0.0.1:${(closed.address() as AddressInfo).port}`;
    const listed = await fetch(`${closedBase}/v1/previews/list`, {
      method: 'POST',
      headers: { authorization: `Bearer ${API_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify(TARGET),
    });
    expect(listed.status).toBe(503);
    const proxied = await fetch(`${closedBase}/v1/previews/proxy/web/`, {
      headers: { authorization: `Bearer ${API_KEY}`, 'x-sandbox-subject': TARGET.subject },
    });
    expect(proxied.status).toBe(503);
    await new Promise((resolve) => closed.close(resolve));
  });
});
