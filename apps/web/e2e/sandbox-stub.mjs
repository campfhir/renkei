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

/* global process, Buffer, setTimeout, URL, URLSearchParams, console */

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

/**
 * What the code pane reads: the files the tree names, as text. A file a
 * person uploads or saves lands in the workspace's own map and wins.
 */
const FILES = {
  'package.json': `{
  "name": "billing-service",
  "version": "2.4.1",
  "private": true,
  "scripts": {
    "test": "vitest run",
    "start": "node dist/index.js"
  }
}
`,
  'README.md': `# Billing service

Invoices, dunning and the nightly jobs.

## Running it

    pnpm install
    pnpm start
`,
  'src/billing.ts': `import { sleep } from './util';

const MAX_ATTEMPTS = 5;

export interface InvoiceJob {
  id: string;
  attempts: number;
}

export async function retryInvoice(job: InvoiceJob) {
  const attempt = job.attempts + 1;
  if (attempt > MAX_ATTEMPTS) {
    return { status: 'failed', reason: 'max attempts reached' };
  }
  await sleep(backoff(attempt));
  return run(job, attempt);
}

function backoff(attempt: number): number {
  return Math.min(60_000, 500 * 2 ** attempt);
}
`,
  'src/index.ts': `import { retryInvoice } from './billing';

export { retryInvoice };
`,
};

/** A commit made from the pane: the counter behind its short hash. */
let commitCounter = 0;

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

/**
 * Code project services, stood in for: the organization's image rules
 * (per tenant, seeded like migration 122 does) and the services a
 * project "runs" — no engine, a start just reads running at a made-up
 * address, which is enough to exercise the admin page and the tools'
 * plumbing.
 */
const RULE_SEED = [
  ['docker.io/library/postgres', 'PostgreSQL (official image)'],
  ['docker.io/pgvector/pgvector', 'PostgreSQL with the vector extension'],
  ['docker.io/library/redis', 'Redis (official image)'],
  ['docker.io/valkey/valkey', 'Valkey, the Redis fork'],
  ['docker.io/library/mysql', 'MySQL (official image)'],
  ['docker.io/library/mariadb', 'MariaDB (official image)'],
  ['docker.io/library/mongo', 'MongoDB (official image)'],
  ['docker.io/library/rabbitmq', 'RabbitMQ (official image)'],
  ['mcr.microsoft.com/mssql/server', 'SQL Server on Linux'],
  ['mcr.microsoft.com/azure-storage/azurite', 'Azurite, the Azure Storage emulator'],
];
const rulesByTenant = new Map();
function rulesOf(tenantId) {
  let rules = rulesByTenant.get(tenantId);
  if (!rules) {
    rules = new Map();
    for (const [pattern, note] of RULE_SEED) {
      const id = randomUUID();
      const now = new Date().toISOString();
      rules.set(id, { id, pattern, note, registryUsername: null, createdAt: now, updatedAt: now });
    }
    rulesByTenant.set(tenantId, rules);
  }
  return rules;
}

/** The worker's normalizeImageRule, in miniature: enough for what the page types. */
function normalizeRule(raw) {
  let value = String(raw ?? '')
    .trim()
    .replace(/\/+$/, '');
  if (!value || /\s/.test(value)) return { error: 'A rule is required.' };
  if (value.includes('*') && !value.endsWith('/*')) {
    return {
      error: 'A wildcard is only `/*` at the end of a rule, for everything under a namespace.',
    };
  }
  const wildcard = value.endsWith('/*');
  if (wildcard) value = value.slice(0, -2);
  let dropped = null;
  if (!wildcard) {
    const at = value.indexOf('@');
    if (at >= 0) {
      dropped = 'the digest';
      value = value.slice(0, at);
    }
    const lastSlash = value.lastIndexOf('/');
    const colon = value.lastIndexOf(':');
    if (colon > lastSlash && !(lastSlash < 0 && value.includes('.'))) {
      dropped = `the tag ${value.slice(colon + 1)}`;
      value = value.slice(0, colon);
    }
  }
  const segments = value.toLowerCase().split('/');
  let host = 'docker.io';
  if (
    segments.length > 1 &&
    (segments[0].includes('.') || segments[0].includes(':') || segments[0] === 'localhost')
  ) {
    host = segments.shift();
  } else if (
    segments.length === 1 &&
    (segments[0].includes('.') || /^localhost(:\d+)?$/.test(segments[0]))
  ) {
    if (wildcard)
      return { error: 'A whole registry is just its host; `/*` belongs after a namespace.' };
    return { pattern: segments[0], dropped: null };
  }
  if (segments.some((segment) => !/^[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*$/.test(segment))) {
    return {
      error:
        'A repository path is lower-case letters, digits and single dots, dashes or underscores between them.',
    };
  }
  if (host === 'docker.io' && segments.length === 1 && !wildcard) segments.unshift('library');
  return { pattern: `${host}/${segments.join('/')}${wildcard ? '/*' : ''}`, dropped };
}

function handleRules(op, body, response) {
  const rules = rulesOf(body.tenantId);
  switch (op) {
    case 'list':
      return json(response, 200, {
        rules: [...rules.values()].sort((a, b) => a.pattern.localeCompare(b.pattern)),
      });
    case 'restore': {
      let added = 0;
      for (const [pattern, note] of RULE_SEED) {
        if ([...rules.values()].some((rule) => rule.pattern === pattern)) continue;
        const id = randomUUID();
        const now = new Date().toISOString();
        rules.set(id, {
          id,
          pattern,
          note,
          registryUsername: null,
          createdAt: now,
          updatedAt: now,
        });
        added += 1;
      }
      return json(response, 200, { added, rules: [...rules.values()] });
    }
    case 'delete': {
      if (!rules.has(body.id ?? '')) return error(response, 404, 'not_found', 'No such rule.');
      rules.delete(body.id);
      return json(response, 200, { deleted: true, id: body.id });
    }
    case 'set': {
      const normalized = normalizeRule(body.pattern);
      if (normalized.error) return error(response, 400, 'bad_request', normalized.error);
      const username =
        typeof body.registryUsername === 'string' ? body.registryUsername.trim() : '';
      const secret = typeof body.registrySecret === 'string' ? body.registrySecret : '';
      if ((username && !secret) || (!username && secret)) {
        return error(
          response,
          400,
          'bad_request',
          'A registry credential is a username and a secret together.'
        );
      }
      const note = typeof body.note === 'string' && body.note.trim() ? body.note.trim() : null;
      const duplicate = [...rules.values()].find(
        (rule) => rule.pattern === normalized.pattern && rule.id !== body.id
      );
      if (duplicate)
        return error(response, 409, 'exists', 'A rule for that pattern already exists.');
      const now = new Date().toISOString();
      if (body.id) {
        const existing = rules.get(body.id);
        if (!existing) return error(response, 404, 'not_found', 'No such rule.');
        existing.pattern = normalized.pattern;
        existing.note = note;
        existing.updatedAt = now;
        if (username) existing.registryUsername = username;
        else if (body.clearCredential === true) existing.registryUsername = null;
        return json(response, 200, { rule: existing, dropped: normalized.dropped });
      }
      const id = randomUUID();
      const rule = {
        id,
        pattern: normalized.pattern,
        note,
        registryUsername: username || null,
        createdAt: now,
        updatedAt: now,
      };
      rules.set(id, rule);
      return json(response, 201, { rule, dropped: normalized.dropped });
    }
    default:
      return error(response, 404, 'unknown_operation');
  }
}

function handleServices(op, body, response) {
  if (op.startsWith('rules/')) return handleRules(op.slice('rules/'.length), body, response);
  const scope = scopeOf(body);
  scope.services ??= new Map();
  const wireService = (service) => ({ ...service });
  switch (op) {
    case 'list':
      return json(response, 200, { services: [...scope.services.values()].map(wireService) });
    case 'start': {
      const name = String(body.name ?? '');
      if (!/^[a-z][a-z0-9-]{0,31}$/.test(name))
        return error(
          response,
          400,
          'bad_request',
          'A service name is lower-case letters, digits and dashes.'
        );
      if (scope.services.has(name))
        return error(response, 409, 'exists', `A service named ${name} is already running.`);
      const normalized = normalizeRule(String(body.image ?? ''));
      if (normalized.error) return error(response, 400, 'bad_request', normalized.error);
      const allowed = [...rulesOf(body.tenantId).values()].some((rule) =>
        rule.pattern.endsWith('/*')
          ? normalized.pattern.startsWith(rule.pattern.slice(0, -1))
          : rule.pattern.includes('/')
            ? rule.pattern === normalized.pattern
            : normalized.pattern.startsWith(`${rule.pattern}/`)
      );
      if (!allowed)
        return error(
          response,
          403,
          'not_allowed',
          `${body.image} is not an image this organization allows.`
        );
      const now = new Date().toISOString();
      const service = {
        id: randomUUID(),
        name,
        image:
          normalized.pattern +
          (normalized.dropped?.startsWith('the tag ')
            ? `:${normalized.dropped.slice(8)}`
            : ':latest'),
        status: 'running',
        error: null,
        host: `172.20.0.${scope.services.size + 2}`,
        ports: normalized.pattern.includes('postgres')
          ? [5432]
          : normalized.pattern.includes('redis')
            ? [6379]
            : [],
        exportNames: Object.keys(body.exports ?? {}).sort(),
        createdAt: now,
        lastUsedAt: now,
        expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      };
      scope.services.set(name, service);
      return json(response, 201, { service: wireService(service) });
    }
    case 'stop': {
      const service = scope.services.get(String(body.name ?? ''));
      if (!service) return error(response, 404, 'not_found', 'No such service — see the list.');
      scope.services.delete(service.name);
      return json(response, 200, { service: { ...service, status: 'stopped', host: null } });
    }
    case 'logs': {
      const service = scope.services.get(String(body.name ?? ''));
      if (!service) return error(response, 404, 'not_found', 'No such service — see the list.');
      return json(response, 200, {
        service: wireService(service),
        logs: 'database system is ready to accept connections\n',
        truncated: false,
      });
    }
    case 'tail': {
      // Two stamped lines per service, and one more each time the page
      // follows, so a tail that asks for what came after its last stamp
      // sees the stream move.
      const entries = [];
      for (const service of scope.services.values()) {
        service.tailTicks = (service.tailTicks ?? 0) + 1;
        const base = Date.parse(service.createdAt);
        const lines = ['starting up', 'database system is ready to accept connections'];
        for (let tick = 3; tick <= service.tailTicks + 1; tick += 1)
          lines.push(`checkpoint ${tick - 2}`);
        lines.forEach((line, index) => {
          const at = new Date(base + index * 1000).toISOString().replace('Z', '000000Z');
          entries.push({ service: service.name, at, line });
        });
      }
      const since = typeof body.since === 'string' ? body.since : null;
      const kept = entries
        .filter((entry) => !since || entry.at > since)
        .sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
      return json(response, 200, { entries: kept, truncated: false, unreadable: [] });
    }
    default:
      return error(response, 404, 'unknown_operation');
  }
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
    case 'read': {
      const workspace = scope.workspaces.get(body.id ?? '');
      if (!workspace) return error(response, 404, 'not_found', 'No such workspace — see the list.');
      if (workspace.status !== 'ready')
        return error(response, 409, 'not_ready', 'That workspace is still cloning.');
      const path = body.path ?? '';
      const uploaded = workspace.files.get(path);
      const text = uploaded ? uploaded.toString('utf8') : FILES[path];
      if (text === undefined) return error(response, 404, 'not_found', `No such file: ${path}`);
      const lines = text.split('\n');
      return json(response, 200, {
        path,
        text,
        sizeBytes: Buffer.byteLength(text, 'utf8'),
        totalLines: lines.length,
        startLine: 1,
        endLine: lines.length,
      });
    }
    case 'write': {
      const workspace = scope.workspaces.get(body.id ?? '');
      if (!workspace) return error(response, 404, 'not_found', 'No such workspace — see the list.');
      const created = !workspace.files.has(body.path) && FILES[body.path] === undefined;
      const bytes = Buffer.from(body.content ?? '', 'utf8');
      workspace.files.set(body.path, bytes);
      return json(response, 200, { path: body.path, created, sizeBytes: bytes.byteLength });
    }
    case 'git-status': {
      const workspace = scope.workspaces.get(body.id ?? '');
      if (!workspace) return error(response, 404, 'not_found', 'No such workspace — see the list.');
      return json(response, 200, {
        branch: workspace.branch,
        status: ' M src/billing.ts',
        diffStat: ' src/billing.ts | 4 +++-',
      });
    }
    case 'git-commit': {
      const workspace = scope.workspaces.get(body.id ?? '');
      if (!workspace) return error(response, 404, 'not_found', 'No such workspace — see the list.');
      if (!body.message || !body.author?.name) return error(response, 400, 'bad_request');
      if (body.newBranch) workspace.branch = body.newBranch;
      commitCounter += 1;
      const commit = `c0ffee${String(commitCounter).padStart(2, '0')}`;
      workspace.commits = workspace.commits ?? [];
      workspace.commits.push({ commit, message: body.message, branch: workspace.branch });
      return json(response, 200, { branch: workspace.branch, commit });
    }
    case 'git-push': {
      const workspace = scope.workspaces.get(body.id ?? '');
      if (!workspace) return error(response, 404, 'not_found', 'No such workspace — see the list.');
      if (!body.authHeader) return error(response, 400, 'bad_request');
      const remoteBranch = body.branch || workspace.branch;
      return json(response, 200, {
        branch: workspace.branch,
        remoteBranch,
        output: `To bitbucket.org:acme/billing-service.git\n * [new branch] ${workspace.branch} -> ${remoteBranch}`,
      });
    }
    case 'git-show': {
      const workspace = scope.workspaces.get(body.id ?? '');
      if (!workspace) return error(response, 404, 'not_found', 'No such workspace — see the list.');
      const found = (workspace.commits ?? []).find((entry) => entry.commit.startsWith(body.commit));
      if (!found) return error(response, 404, 'not_found', 'No such commit.');
      return json(response, 200, {
        branch: workspace.branch,
        commit: {
          sha: found.commit.padEnd(40, '0'),
          shortSha: found.commit,
          subject: found.message.split('\n')[0],
          body: '',
          author: body.author?.name ?? 'E2E Dev',
          date: new Date().toISOString(),
          parents: [],
        },
        pushed: false,
        inHead: found.branch === workspace.branch,
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

/**
 * Pipelines setup per repository, for the project page's Pipelines
 * section: the switch, the repository's variables and one deployment
 * environment's. Keyed by full_name; the pipelines spec seeds a project
 * on a repository of its own per Playwright project, so the three never
 * share a row.
 */
const PIPELINES = new Map();
let nextVariableNumber = 1;

function pipelinesOf(fullName) {
  if (!PIPELINES.has(fullName)) {
    PIPELINES.set(fullName, {
      enabled: false,
      /** bitbucket-pipelines.yml once committed from the page; null before. */
      configFile: null,
      // Two runs, as Bitbucket lists them newest first: the latest failed
      // on a branch, the one before passed on main.
      runs: [
        {
          uuid: '{run-0002}',
          build_number: 2,
          state: { name: 'COMPLETED', result: { name: 'FAILED' } },
          target: { ref_name: 'feature/retry-invoices', commit: { hash: 'abc123def456' } },
          creator: { display_name: 'E2E Dev' },
          created_on: '2026-09-22T14:05:00Z',
          duration_in_seconds: 312,
        },
        {
          uuid: '{run-0001}',
          build_number: 1,
          state: { name: 'COMPLETED', result: { name: 'SUCCESSFUL' } },
          target: { ref_name: 'main', commit: { hash: '0123456789ab' } },
          creator: {},
          created_on: '2026-09-21T09:30:00Z',
          duration_in_seconds: 95,
        },
      ],
      variables: [],
      environments: [
        {
          uuid: '{e1e1e1e1-0000-4000-8000-000000000001}',
          name: 'Production',
          environment_type: { name: 'Production' },
          rank: 2,
          variables: [],
        },
      ],
    });
  }
  return PIPELINES.get(fullName);
}

/** The variable endpoints, on the repository's list or an environment's. */
function handlePipelineVariables(request, response, list, uuid) {
  if (!uuid) {
    if (request.method === 'GET') {
      return json(response, 200, {
        values: list.map((variable) =>
          variable.secured ? { ...variable, value: undefined } : variable
        ),
      });
    }
    if (request.method === 'POST') {
      void readBody(request).then((body) => {
        if (list.some((variable) => variable.key === body.key)) {
          return error(response, 409, 'variable_exists', 'Variable already exists');
        }
        const created = {
          uuid: `{aaaaaaaa-0000-4000-8000-${String(nextVariableNumber++).padStart(12, '0')}}`,
          key: body.key,
          value: body.value ?? '',
          secured: body.secured === true,
          type: 'pipeline_variable',
        };
        list.push(created);
        json(response, 200, created.secured ? { ...created, value: undefined } : created);
      });
      return;
    }
    return error(response, 405, 'method_not_allowed');
  }
  const index = list.findIndex((variable) => variable.uuid === decodeURIComponent(uuid));
  if (index === -1) return error(response, 404, 'not_found');
  if (request.method === 'DELETE') {
    list.splice(index, 1);
    response.writeHead(204);
    return response.end();
  }
  if (request.method === 'PUT') {
    void readBody(request).then((body) => {
      const current = list[index];
      const updated = {
        ...current,
        key: body.key ?? current.key,
        secured: body.secured ?? current.secured,
        ...(body.value !== undefined ? { value: body.value } : {}),
      };
      list[index] = updated;
      json(response, 200, updated.secured ? { ...updated, value: undefined } : updated);
    });
    return;
  }
  return error(response, 405, 'method_not_allowed');
}

function handleBitbucket(request, url, response) {
  const path = url.pathname.slice('/bitbucket/2.0'.length);
  const pipelinesConfig = /^\/repositories\/([^/]+)\/([^/]+)\/pipelines_config$/.exec(path);
  if (pipelinesConfig) {
    const state = pipelinesOf(`${pipelinesConfig[1]}/${pipelinesConfig[2]}`);
    if (request.method === 'PUT') {
      void readBody(request).then((body) => {
        state.enabled = body.enabled === true;
        json(response, 200, { enabled: state.enabled });
      });
      return;
    }
    return json(response, 200, { enabled: state.enabled });
  }
  const runs = /^\/repositories\/([^/]+)\/([^/]+)\/pipelines$/.exec(path);
  if (runs) {
    const state = pipelinesOf(`${runs[1]}/${runs[2]}`);
    if (request.method === 'POST') {
      // A run started from the page: pending, newest, by the person.
      void readBody(request).then((body) => {
        const target = body.target ?? {};
        const run = {
          uuid: `{run-${String(state.runs.length + 1).padStart(4, '0')}}`,
          build_number: state.runs.length + 1,
          state: { name: 'PENDING', stage: { name: 'PENDING' } },
          target: {
            ref_type: target.ref_type ?? 'branch',
            ref_name: target.ref_name ?? 'main',
            ...(target.selector ? { selector: target.selector } : {}),
          },
          creator: { display_name: 'E2E Dev' },
          created_on: new Date().toISOString(),
        };
        state.runs.unshift(run);
        json(response, 201, run);
      });
      return;
    }
    return json(response, 200, { values: state.runs });
  }
  const repoVariables =
    /^\/repositories\/([^/]+)\/([^/]+)\/pipelines_config\/variables(?:\/([^/]+))?$/.exec(path);
  if (repoVariables) {
    const state = pipelinesOf(`${repoVariables[1]}/${repoVariables[2]}`);
    return handlePipelineVariables(request, response, state.variables, repoVariables[3]);
  }
  const environments = /^\/repositories\/([^/]+)\/([^/]+)\/environments$/.exec(path);
  if (environments) {
    const state = pipelinesOf(`${environments[1]}/${environments[2]}`);
    return json(response, 200, {
      values: state.environments.map((environment) => {
        const rest = { ...environment };
        delete rest.variables;
        return rest;
      }),
    });
  }
  const environmentVariables =
    /^\/repositories\/([^/]+)\/([^/]+)\/deployments_config\/environments\/([^/]+)\/variables(?:\/([^/]+))?$/.exec(
      path
    );
  if (environmentVariables) {
    const state = pipelinesOf(`${environmentVariables[1]}/${environmentVariables[2]}`);
    const environment = state.environments.find(
      (candidate) => candidate.uuid === decodeURIComponent(environmentVariables[3])
    );
    if (!environment) return error(response, 404, 'not_found');
    return handlePipelineVariables(
      request,
      response,
      environment.variables,
      environmentVariables[4]
    );
  }
  // The membership listing the app reads (bare /workspaces is deprecated
  // and refuses newer tokens): workspace_access rows wrapping each workspace.
  if (path === '/user/workspaces') {
    return json(response, 200, {
      values: BITBUCKET.workspaces.map((workspace) => ({ administrator: true, workspace })),
    });
  }
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
    const [, workspace, slug] = one;
    const fullName = `${workspace}/${slug}`;
    if (request.method === 'POST') {
      // Repository creation: the new-project form's "Create new
      // repository" tab. An empty repo — no mainbranch until something
      // is pushed to it, same as the real, freshly created thing.
      // Re-creating the same full_name replaces it rather than refusing,
      // so re-running the suite against a stub left over from a previous
      // run behaves the same as a clean one.
      void readBody(request).then((body) => {
        const created = {
          full_name: fullName,
          name: body.name || slug,
          project: { key: body.project?.key ?? '' },
          updated_on: new Date().toISOString(),
        };
        const existing = BITBUCKET.repos.findIndex((entry) => entry.full_name === fullName);
        if (existing === -1) BITBUCKET.repos.push(created);
        else BITBUCKET.repos[existing] = created;
        json(response, 200, created);
      });
      return;
    }
    const repo = BITBUCKET.repos.find((entry) => entry.full_name === fullName);
    if (repo) return json(response, 200, repo);
    // The pipelines spec's repositories: one per Playwright project, kept
    // out of the browsable list so the new-project form's counts hold.
    if (workspace === 'acme' && slug.startsWith('pipelines-demo-')) {
      return json(response, 200, {
        full_name: fullName,
        name: slug,
        project: { key: 'BILL' },
        mainbranch: { name: 'main' },
        updated_on: '2026-09-01T00:00:00Z',
      });
    }
    return error(response, 404, 'not_found');
  }
  // A file committed from the page: the src endpoint's form post, the
  // file keyed by its path beside `message` and `branch`. 201, no body.
  const commit = /^\/repositories\/([^/]+)\/([^/]+)\/src$/.exec(path);
  if (commit && request.method === 'POST') {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      const form = new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
      const state = pipelinesOf(`${commit[1]}/${commit[2]}`);
      const text = form.get('bitbucket-pipelines.yml');
      if (typeof text === 'string') state.configFile = text;
      response.writeHead(201);
      response.end();
    });
    return;
  }
  const listing = /^\/repositories\/([^/]+)\/([^/]+)\/src\/([^/]+)\/(.*)$/.exec(path);
  if (listing && (listing[4] === '' || listing[4].endsWith('/'))) {
    const dir = decodeURIComponent(listing[4].replace(/\/$/, ''));
    const entries = TREE[dir];
    if (!entries) return error(response, 404, 'not_found');
    return json(response, 200, {
      values: entries.map((entry) =>
        entry.kind === 'dir'
          ? { type: 'commit_directory', path: entry.path }
          : { type: 'commit_file', path: entry.path, size: entry.sizeBytes }
      ),
    });
  }
  const file = /^\/repositories\/([^/]+)\/([^/]+)\/src\/([^/]+)\/(.+)$/.exec(path);
  if (file) {
    const name = decodeURIComponent(file[4]);
    if (name === 'bitbucket-pipelines.yml') {
      const state = pipelinesOf(`${file[1]}/${file[2]}`);
      if (state.configFile === null) return error(response, 404, 'not_found');
      response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      return response.end(state.configFile);
    }
    if (name !== 'README.md') return error(response, 404, 'not_found');
    const payload = README;
    response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
    return response.end(payload);
  }
  return error(response, 404, 'not_found');
}

/**
 * Jira administration's custom field option endpoints, stood in for: the
 * app is pointed here with JIRA_ADMIN_API_BASE_URL, so applying a change
 * request from its review page runs against real wire shapes without
 * Atlassian. One option list per (site, field, context), seeded on first
 * read; the specs use a fresh site id per run, so a rerun against a stub
 * left running never sees the last run's options.
 */
const JIRA_OPTIONS = new Map();
let nextOptionId = 20000;

function jiraOptions(key) {
  if (!JIRA_OPTIONS.has(key)) {
    JIRA_OPTIONS.set(key, [
      { id: '10001', value: 'Customer', disabled: false },
      { id: '10002', value: 'Partner', disabled: false },
      { id: '10003', value: 'Legacy', disabled: false },
    ]);
  }
  return JIRA_OPTIONS.get(key);
}

function jiraError(response, status, message) {
  json(response, status, { errorMessages: [message], errors: {} });
}

function handleJiraAdmin(request, url, response) {
  const match =
    /^\/jira\/([^/]+)\/rest\/api\/3\/field\/([^/]+)\/context\/([^/]+)\/option(\/move)?$/.exec(
      url.pathname
    );
  if (!match) return jiraError(response, 404, 'The stub does not answer that path.');
  const [, cloudId, fieldId, contextId, move] = match;
  const options = jiraOptions(`${cloudId}|${fieldId}|${contextId}`);
  const sameLevel = (a, b) => (a.optionId ?? null) === (b.optionId ?? null);

  if (request.method === 'GET' && !move) {
    const startAt = Number(url.searchParams.get('startAt') ?? '0');
    const maxResults = Number(url.searchParams.get('maxResults') ?? '100');
    const values = options.slice(startAt, startAt + maxResults);
    return json(response, 200, {
      startAt,
      maxResults,
      total: options.length,
      isLast: startAt + values.length >= options.length,
      values,
    });
  }
  void readBody(request).then((body) => {
    if (request.method === 'POST' && !move) {
      const created = [];
      for (const option of body.options ?? []) {
        const candidate = { value: option.value, optionId: option.optionId };
        if (
          options.some(
            (existing) => sameLevel(existing, candidate) && existing.value === option.value
          )
        ) {
          return jiraError(response, 400, `The option ${option.value} already exists.`);
        }
        const row = {
          id: String(nextOptionId++),
          value: option.value,
          disabled: option.disabled === true,
          ...(option.optionId ? { optionId: option.optionId } : {}),
        };
        options.push(row);
        created.push(row);
      }
      return json(response, 200, { options: created });
    }
    if (request.method === 'PUT' && !move) {
      const updates = body.options ?? [];
      // Jira's rule: any unknown id and nothing is updated.
      if (updates.some((update) => !options.some((option) => option.id === update.id))) {
        return jiraError(response, 404, 'One or more options were not found.');
      }
      for (const update of updates) {
        const option = options.find((candidate) => candidate.id === update.id);
        if (typeof update.value === 'string') option.value = update.value;
        if (typeof update.disabled === 'boolean') option.disabled = update.disabled;
      }
      return json(response, 200, {
        options: updates.map((update) => options.find((option) => option.id === update.id)),
      });
    }
    if (request.method === 'PUT' && move) {
      const ids = body.customFieldOptionIds ?? [];
      const moving = ids.map((id) => options.find((option) => option.id === id));
      if (moving.some((option) => !option)) {
        return jiraError(response, 404, 'One or more options were not found.');
      }
      const rest = options.filter((option) => !ids.includes(option.id));
      const ordered = body.position === 'Last' ? [...rest, ...moving] : [...moving, ...rest];
      options.splice(0, options.length, ...ordered);
      response.writeHead(204);
      return response.end();
    }
    return jiraError(response, 405, 'Method not allowed.');
  });
}

const server = createServer((request, response) => {
  const url = new URL(request.url ?? '/', 'http://stub.internal');
  if (request.method === 'GET' && url.pathname === '/health')
    return json(response, 200, { ok: true });
  // Bitbucket, stood in for: the app is pointed here with
  // BITBUCKET_API_BASE_URL, so the picker's browsing and a project page's
  // README are exercised without the network.
  if (url.pathname.startsWith('/bitbucket/2.0/')) return handleBitbucket(request, url, response);
  // Jira administration's option endpoints, for applying change requests.
  if (url.pathname.startsWith('/jira/')) return handleJiraAdmin(request, url, response);
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
    // The rule verbs are the organization's: a tenant, no subject.
    if (op.startsWith('services/rules/')) {
      if (!body.tenantId) return error(response, 400, 'bad_request');
      return handleServices(op.slice('services/'.length), body, response);
    }
    if (!body.tenantId || !body.subject) return error(response, 400, 'bad_request');
    if (op.startsWith('services/'))
      return handleServices(op.slice('services/'.length), body, response);
    if (op.startsWith('workspaces/'))
      return handleWorkspaces(op.slice('workspaces/'.length), body, response);
    if (op.startsWith('env/')) return handleEnv(op.slice('env/'.length), body, response);
    return error(response, 404, 'unknown_operation');
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`sandbox stub listening on 127.0.0.1:${PORT}`);
});
