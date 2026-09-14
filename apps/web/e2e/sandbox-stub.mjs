/**
 * A stand-in for apps/worker-sandbox, for the browser suite: the handful
 * of workspace and environment verbs the Code pages drive, answered from
 * memory with the worker's own wire shapes. No git, no disk, no Bitbucket
 * — a clone "runs" for a moment and then reads ready, which is enough to
 * exercise the page that follows it. State is per (tenantId, subject),
 * exactly as the real worker scopes it, so the three Playwright projects
 * running side by side never see each other's checkouts.
 *
 * Started by playwright.config.ts as a second webServer, on the port the
 * app's SANDBOX_WORKER_URL names (see the repo-root .env.development).
 */

/* global process, Buffer, setTimeout, URL, console */

import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';

const PORT = Number(process.env.SANDBOX_STUB_PORT ?? '8092');
const API_KEY = process.env.SANDBOX_WORKER_API_KEY ?? 'e2e-sandbox-key';
/** How long a stubbed clone stays "cloning" before it reads ready. */
const CLONE_MS = Number(process.env.SANDBOX_STUB_CLONE_MS ?? '1500');
const ENV_NAME = /^[A-Z_][A-Z0-9_]{0,63}$/;
const RESERVED = new Set(['PATH', 'HOME', 'LD_PRELOAD', 'NODE_OPTIONS']);

/** A checkout's shape, for the tree on the project page. */
const TREE = {
  '': [
    { path: 'src', kind: 'dir', sizeBytes: null },
    { path: 'package.json', kind: 'file', sizeBytes: 812 },
    { path: 'README.md', kind: 'file', sizeBytes: 1204 },
  ],
  src: [
    { path: 'src/billing.ts', kind: 'file', sizeBytes: 4410 },
    { path: 'src/index.ts', kind: 'file', sizeBytes: 302 },
  ],
};

/** What the checkout has uncommitted, for the Changes button and its diff. */
const SAMPLE_DIFF = `diff --git a/src/billing.ts b/src/billing.ts
index 1111111..2222222 100644
--- a/src/billing.ts
+++ b/src/billing.ts
@@ -10,7 +10,9 @@ export async function retryInvoice(job: InvoiceJob) {
   const attempt = job.attempts + 1;
-  if (attempt > 3) throw new Error('gave up');
+  if (attempt > MAX_ATTEMPTS) {
+    return { status: 'failed', reason: 'max attempts reached' };
+  }
   await sleep(backoff(attempt));
   return run(job, attempt);
 }
`;

/** scope key → { workspaces: Map<id, workspace>, env: Map<name, variable> } */
const scopes = new Map();

function scopeOf(body) {
  const key = `${body.tenantId}\n${body.subject}`;
  if (!scopes.has(key)) scopes.set(key, { workspaces: new Map(), env: new Map() });
  return scopes.get(key);
}

function json(response, status, body) {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload),
  });
  response.end(payload);
}

function error(response, status, type, message) {
  json(response, status, { error: { type, message } });
}

function wire(workspace) {
  const rest = { ...workspace };
  delete rest.files;
  return rest;
}

function envWire(variable) {
  return { ...variable };
}

function readBody(request) {
  return new Promise((resolve) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch {
        resolve({});
      }
    });
  });
}

function setVariable(scope, name, value) {
  if (!ENV_NAME.test(name) || RESERVED.has(name)) {
    return `${name} is not a usable variable name.`;
  }
  if (typeof value !== 'string' || !value) return `${name}: a value is required.`;
  const now = new Date().toISOString();
  const existing = scope.env.get(name);
  scope.env.set(name, {
    id: existing?.id ?? randomUUID(),
    name,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    lastUsedAt: existing?.lastUsedAt ?? null,
  });
  return null;
}

function handleWorkspaces(op, body, response) {
  const scope = scopeOf(body);
  switch (op) {
    case 'clone': {
      if (!/^https:\/\/bitbucket\.org\/.+\.git$/.test(body.cloneUrl ?? '') || !body.authHeader) {
        return error(response, 400, 'bad_request');
      }
      const now = new Date();
      const workspace = {
        id: randomUUID(),
        provider: body.provider,
        repoFullName: body.repoFullName,
        branch: body.branch || '(default)',
        status: 'cloning',
        error: null,
        sizeBytes: 0,
        createdAt: now.toISOString(),
        lastUsedAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + 7 * 86_400_000).toISOString(),
        /** Uploaded bytes by path; never on the wire, only counted. */
        files: new Map(),
      };
      scope.workspaces.set(workspace.id, workspace);
      // A repository named "fails" clones badly, so the page's failure
      // state can be looked at too.
      setTimeout(() => {
        if (!scope.workspaces.has(workspace.id)) return;
        if (/\/fails$/.test(workspace.repoFullName)) {
          workspace.status = 'failed';
          workspace.error = 'repository not found';
        } else {
          workspace.status = 'ready';
          workspace.branch = body.branch || 'main';
          workspace.sizeBytes = 4_321_000;
        }
      }, CLONE_MS);
      return json(response, 200, { workspace: wire(workspace) });
    }
    case 'list':
      return json(response, 200, { workspaces: [...scope.workspaces.values()].map(wire) });
    case 'get': {
      const workspace = scope.workspaces.get(body.id ?? '');
      if (!workspace) return error(response, 404, 'not_found', 'No such workspace — see the list.');
      return json(response, 200, { workspace: wire(workspace) });
    }
    case 'ls': {
      const workspace = scope.workspaces.get(body.id ?? '');
      if (!workspace) return error(response, 404, 'not_found', 'No such workspace — see the list.');
      if (workspace.status !== 'ready')
        return error(response, 409, 'not_ready', 'That workspace is still cloning.');
      const path = body.path ?? '';
      const listing = TREE[path];
      if (!listing) return error(response, 404, 'not_found', `${path} is not a directory.`);
      return json(response, 200, { path, entries: listing });
    }
    case 'git-diff': {
      const workspace = scope.workspaces.get(body.id ?? '');
      if (!workspace) return error(response, 404, 'not_found', 'No such workspace — see the list.');
      if (workspace.status !== 'ready')
        return error(response, 409, 'not_ready', 'That workspace is still cloning.');
      return json(response, 200, {
        branch: workspace.branch,
        diff: body.statOnly ? '' : SAMPLE_DIFF,
        files: [{ path: 'src/billing.ts', added: 3, deleted: 1, status: 'modified' }],
        truncated: false,
      });
    }
    case 'delete': {
      const workspace = scope.workspaces.get(body.id ?? '');
      if (!workspace) return error(response, 404, 'not_found');
      scope.workspaces.delete(workspace.id);
      return json(response, 200, {
        deleted: true,
        id: workspace.id,
        repoFullName: workspace.repoFullName,
      });
    }
    default:
      return error(response, 404, 'unknown_operation');
  }
}

function handleEnv(op, body, response) {
  const scope = scopeOf(body);
  switch (op) {
    case 'list':
      return json(response, 200, { variables: [...scope.env.values()].map(envWire) });
    case 'set': {
      const failure = setVariable(scope, body.name ?? '', body.value);
      if (failure) return error(response, 400, 'bad_request', failure);
      return json(response, 200, { variable: envWire(scope.env.get(body.name)) });
    }
    case 'replace': {
      const values = body.values && typeof body.values === 'object' ? body.values : null;
      if (!values) return error(response, 400, 'bad_request', 'values must be an object.');
      for (const [name, value] of Object.entries(values)) {
        if (!ENV_NAME.test(name) || RESERVED.has(name)) {
          return error(response, 400, 'bad_request', `${name} is not a usable variable name.`);
        }
        if (typeof value !== 'string' || !value) {
          return error(response, 400, 'bad_request', `${name}: a value is required.`);
        }
      }
      for (const name of [...scope.env.keys()]) if (!(name in values)) scope.env.delete(name);
      for (const [name, value] of Object.entries(values)) setVariable(scope, name, value);
      return json(response, 200, { variables: [...scope.env.values()].map(envWire) });
    }
    case 'delete': {
      if (!scope.env.has(body.name ?? '')) return error(response, 404, 'not_found');
      scope.env.delete(body.name);
      return json(response, 200, { deleted: true, name: body.name });
    }
    default:
      return error(response, 404, 'unknown_operation');
  }
}

const BITBUCKET = {
  workspaces: [
    { slug: 'acme', name: 'Acme' },
    { slug: 'acme-labs', name: 'Acme Labs' },
  ],
  projects: {
    acme: [
      { key: 'BILL', name: 'Billing' },
      { key: 'NOTIF', name: 'Notifications' },
    ],
    'acme-labs': [{ key: 'LAB', name: 'Experiments' }],
  },
  repos: [
    {
      full_name: 'acme/billing-service',
      name: 'billing-service',
      project: { key: 'BILL' },
      mainbranch: { name: 'main' },
      updated_on: '2026-08-20T00:00:00Z',
    },
    {
      full_name: 'acme/notifications-gateway',
      name: 'notifications-gateway',
      project: { key: 'NOTIF' },
      mainbranch: { name: 'develop' },
      updated_on: '2026-09-01T00:00:00Z',
    },
    {
      full_name: 'acme-labs/prototype',
      name: 'prototype',
      project: { key: 'LAB' },
      mainbranch: { name: 'main' },
      updated_on: '2026-07-01T00:00:00Z',
    },
  ],
};

const README = `# Billing service

Invoices, dunning and the nightly jobs.

## Running it

- \`pnpm install\`
- \`pnpm test\`
`;

function handleBitbucket(url, response) {
  const path = url.pathname.slice('/bitbucket/2.0'.length);
  if (path === '/workspaces') return json(response, 200, { values: BITBUCKET.workspaces });
  const projects = /^\/workspaces\/([^/]+)\/projects$/.exec(path);
  if (projects) {
    return json(response, 200, { values: BITBUCKET.projects[projects[1]] ?? [] });
  }
  const repos = /^\/repositories\/([^/]+)$/.exec(path);
  if (repos) {
    const q = url.searchParams.get('q') ?? '';
    const name = /name ~ "([^"]*)"/.exec(q)?.[1]?.toLowerCase() ?? '';
    const project = /project\.key = "([^"]*)"/.exec(q)?.[1] ?? '';
    return json(response, 200, {
      values: BITBUCKET.repos.filter(
        (repo) =>
          repo.full_name.startsWith(`${repos[1]}/`) &&
          (!name || repo.name.includes(name)) &&
          (!project || repo.project.key === project)
      ),
    });
  }
  const one = /^\/repositories\/([^/]+)\/([^/]+)$/.exec(path);
  if (one) {
    const repo = BITBUCKET.repos.find((entry) => entry.full_name === `${one[1]}/${one[2]}`);
    return repo ? json(response, 200, repo) : error(response, 404, 'not_found');
  }
  const file = /^\/repositories\/([^/]+)\/([^/]+)\/src\/([^/]+)\/(.+)$/.exec(path);
  if (file) {
    if (decodeURIComponent(file[4]) !== 'README.md') return error(response, 404, 'not_found');
    const payload = README;
    response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
    return response.end(payload);
  }
  return error(response, 404, 'not_found');
}

const server = createServer((request, response) => {
  const url = new URL(request.url ?? '/', 'http://stub.internal');
  if (request.method === 'GET' && url.pathname === '/health')
    return json(response, 200, { ok: true });
  // Bitbucket, stood in for: the app is pointed here with
  // BITBUCKET_API_BASE_URL, so the picker's browsing and a project page's
  // README are exercised without the network.
  if (url.pathname.startsWith('/bitbucket/2.0/')) return handleBitbucket(url, response);
  if (request.headers.authorization !== `Bearer ${API_KEY}`) {
    return error(response, 401, 'unauthorized');
  }
  if (request.method !== 'POST') return error(response, 405, 'method_not_allowed');
  // The one verb whose body is the file: it lands in memory, by path.
  if (url.pathname === '/v1/workspaces/upload') {
    const query = Object.fromEntries(url.searchParams);
    if (!query.tenantId || !query.subject) return error(response, 400, 'bad_request');
    const scope = scopeOf(query);
    const workspace = scope.workspaces.get(query.id ?? '');
    if (!workspace) return error(response, 404, 'not_found', 'No such workspace — see the list.');
    if (workspace.status !== 'ready')
      return error(
        response,
        409,
        'not_ready',
        'That workspace is still cloning; check again shortly.'
      );
    if (!query.path || query.path.startsWith('.git/') || query.path.includes('..'))
      return error(response, 400, 'bad_path', 'That path is not usable inside the workspace.');
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      const bytes = Buffer.concat(chunks);
      if (bytes.byteLength === 0)
        return error(response, 400, 'bad_request', 'The request body was empty.');
      const created = !workspace.files.has(query.path);
      workspace.files.set(query.path, bytes);
      json(response, 200, { path: query.path, created, sizeBytes: bytes.byteLength });
    });
    return;
  }
  const op = url.pathname.startsWith('/v1/') ? url.pathname.slice(4) : '';
  void readBody(request).then((body) => {
    if (!body.tenantId || !body.subject) return error(response, 400, 'bad_request');
    if (op.startsWith('workspaces/'))
      return handleWorkspaces(op.slice('workspaces/'.length), body, response);
    if (op.startsWith('env/')) return handleEnv(op.slice('env/'.length), body, response);
    return error(response, 404, 'unknown_operation');
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`sandbox stub listening on 127.0.0.1:${PORT}`);
});
