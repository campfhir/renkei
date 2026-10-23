/**
 * A stand-in for apps/worker-sandbox, for the browser suite: the handful
 * of workspace and environment verbs the Code pages drive, answered from
 * memory with the worker's own wire shapes. No git, no disk, no Bitbucket
 * — a clone "runs" for a moment and then reads ready, which is enough to
 * exercise the page that follows it. State is per subject,
 * exactly as the real worker scopes it, so the three Playwright projects
 * running side by side never see each other's checkouts.
 *
 * Started by playwright.config.ts as a second webServer, on the port the
 * app's SANDBOX_WORKER_URL names (see the repo-root .env.development).
 * The same process also stands in for Bitbucket, Jira administration's
 * option endpoints and — for a spec whose chat turn has to actually run
 * — an Anthropic Messages endpoint (handleAnthropic below).
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

/**
 * A checkout's shape, for the tree on the project page — `ignored: true`
 * on `node_modules` gives the tree's ghost-outline styling something to
 * dim in every seeded checkout, the way a real `.gitignore` would.
 */
const TREE = {
  '': [
    { path: 'src', kind: 'dir', sizeBytes: null },
    { path: 'node_modules', kind: 'dir', sizeBytes: null, ignored: true },
    { path: 'package.json', kind: 'file', sizeBytes: 812 },
    { path: 'README.md', kind: 'file', sizeBytes: 1204 },
  ],
  src: [
    { path: 'src/billing.ts', kind: 'file', sizeBytes: 4410 },
    { path: 'src/index.ts', kind: 'file', sizeBytes: 302 },
  ],
  // `left-pad` and its own file are deliberately NOT flagged `ignored`
  // themselves — a real per-directory `git status` query does not
  // reliably re-flag every descendant of an already-ignored directory,
  // so this fixture is what the tree's own ignored-inheritance (an
  // ignored ancestor dims everything under it, regardless of the
  // listing's own flags) has to get right on its own.
  node_modules: [
    { path: 'node_modules/.keep', kind: 'file', sizeBytes: 0, ignored: true },
    { path: 'node_modules/left-pad', kind: 'dir', sizeBytes: null },
  ],
  'node_modules/left-pad': [
    { path: 'node_modules/left-pad/index.js', kind: 'file', sizeBytes: 90 },
  ],
};

/**
 * The tree's create/rename/delete verbs (rm, mv, write of a new path)
 * only ever touch a per-workspace overlay on top of the static `TREE`
 * above — entries added, and paths hidden — so every workspace still
 * starts from the same fixed shape. `pathsIn(dirPath, workspace)` reads
 * the overlay back in; `entryAt` finds one entry anywhere, for `rm`/`mv`
 * to say whether a path exists without the caller repeating the same
 * merge.
 */
function pathsIn(dirPath, workspace) {
  const base = TREE[dirPath] ?? [];
  const extra = workspace.extraEntries?.get(dirPath) ?? [];
  const removed = workspace.removed;
  return [...base, ...extra].filter((entry) => !removed?.has(entry.path));
}

function entryAt(path, workspace) {
  if (workspace.removed?.has(path)) return null;
  for (const dirPath of new Set([
    ...Object.keys(TREE),
    ...(workspace.extraEntries?.keys() ?? []),
  ])) {
    const found = pathsIn(dirPath, workspace).find((entry) => entry.path === path);
    if (found) return found;
  }
  return null;
}

/**
 * mkdir -p, for the stub's own tree: every ancestor of `dirPath` that
 * is not already an entry somewhere gets one, in its own parent's
 * listing, and every ancestor (this one included) gets a listing of
 * its own registered — even empty — so `ls` can open it rather than
 * 404. Mirrors what `write`/`mkdir` create server-side for a nested
 * path whose intermediate folders do not exist yet.
 */
function ensureDirChain(workspace, dirPath) {
  if (!dirPath) return;
  workspace.extraEntries = workspace.extraEntries ?? new Map();
  let parent = '';
  for (const segment of dirPath.split('/')) {
    const current = parent ? `${parent}/${segment}` : segment;
    if (!entryAt(current, workspace)) {
      if (!workspace.extraEntries.has(parent)) workspace.extraEntries.set(parent, []);
      workspace.extraEntries.get(parent).push({ path: current, kind: 'dir', sizeBytes: null });
    }
    if (!workspace.extraEntries.has(current)) workspace.extraEntries.set(current, []);
    workspace.removed?.delete(current);
    parent = current;
  }
}

/** Was `path` there at HEAD (the static fixture), rather than something
 * `write`/`mv` only ever added to a workspace's own overlay? A path that
 * never existed at HEAD reads as "deleted" nowhere — removing it is the
 * same as it never having happened, just like a real `git diff` never
 * lists an untracked file's removal. */
function wasTracked(path) {
  return (TREE[folderOf(path)] ?? []).some((entry) => entry.path === path);
}

function folderOf(path) {
  const index = path.lastIndexOf('/');
  return index < 0 ? '' : path.slice(0, index);
}

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
  const key = body.subject;
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
 * (seeded like migration 122 does) and the services a
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
function rulesOf() {
  let rules = rulesByTenant.get();
  if (!rules) {
    rules = new Map();
    for (const [pattern, note] of RULE_SEED) {
      const id = randomUUID();
      const now = new Date().toISOString();
      rules.set(id, { id, pattern, note, registryUsername: null, createdAt: now, updatedAt: now });
    }
    rulesByTenant.set(rules);
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
  const rules = rulesOf();
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
      const allowed = [...rulesOf().values()].some((rule) =>
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
      const at = new Date(Date.parse(service.createdAt) + 1000)
        .toISOString()
        .replace('Z', '000000Z');
      return json(response, 200, {
        service: wireService(service),
        logs: `${at} database system is ready to accept connections`,
        truncated: false,
        count: 1,
        lastAt: at,
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

/**
 * A language server, scripted: `lsp/languages` says the worker has a
 * TypeScript one; `lsp/open` starts a session for a ready workspace;
 * messages sent to it get the answers below on the session's events
 * stream (a diagnostic on open, a hover, a completion list, a definition
 * in another file), the way the real worker relays a real server's.
 */
const lspSessions = new Map();

function lspEmit(session, message) {
  const text = JSON.stringify(message);
  if (session.stream) session.stream.write(`data: ${text}\n\n`);
  else session.backlog.push(text);
}

function lspAnswer(session, message, rootUri) {
  const { id, method, params } = message;
  switch (method) {
    case 'textDocument/didOpen':
      lspEmit(session, {
        jsonrpc: '2.0',
        method: 'textDocument/publishDiagnostics',
        params: {
          uri: params.textDocument.uri,
          diagnostics: [
            {
              range: { start: { line: 2, character: 6 }, end: { line: 2, character: 18 } },
              severity: 2,
              source: 'stub-ls',
              message: "'MAX_ATTEMPTS' is declared but its value is never read.",
            },
          ],
        },
      });
      return;
    case 'textDocument/hover':
      lspEmit(session, {
        jsonrpc: '2.0',
        id,
        result: {
          contents: {
            kind: 'markdown',
            value: '```typescript\nconst MAX_ATTEMPTS: 5\n```\n\nFrom the stub language server.',
          },
        },
      });
      return;
    case 'textDocument/completion':
      lspEmit(session, {
        jsonrpc: '2.0',
        id,
        result: {
          isIncomplete: false,
          items: [
            {
              label: 'retryInvoice',
              kind: 3,
              detail: 'function retryInvoice(job: InvoiceJob): Promise<void>',
              sortText: '0',
            },
            { label: 'retries', kind: 6, detail: 'let retries: number', sortText: '1' },
          ],
        },
      });
      return;
    case 'textDocument/definition':
      lspEmit(session, {
        jsonrpc: '2.0',
        id,
        result: [
          {
            uri: `${rootUri}/src/index.ts`,
            range: { start: { line: 0, character: 9 }, end: { line: 0, character: 21 } },
          },
        ],
      });
      return;
    default:
      if (id !== undefined && id !== null) {
        lspEmit(session, {
          jsonrpc: '2.0',
          id,
          error: { code: -32601, message: `The stub server has no ${method}.` },
        });
      }
  }
}

function handleLsp(op, body, response) {
  const scope = scopeOf(body);
  if (op === 'languages') return json(response, 200, { languages: ['typescript'] });
  if (op === 'open') {
    const workspace = scope.workspaces.get(body.id ?? '');
    if (!workspace) return error(response, 404, 'not_found', 'No such workspace — see the list.');
    if (workspace.status !== 'ready')
      return error(response, 409, 'not_ready', 'That workspace is still cloning.');
    if (body.server !== 'typescript')
      return error(response, 404, 'server_unavailable', 'This worker has no such language server.');
    const rootUri = `file:///workspaces/stub/${workspace.id}`;
    const existing = [...lspSessions.values()].find(
      (session) => session.workspaceId === workspace.id && session.clientId === body.clientId
    );
    const session = existing ?? {
      id: randomUUID(),
      workspaceId: workspace.id,
      clientId: body.clientId,
      rootUri,
      backlog: [],
      stream: null,
    };
    lspSessions.set(session.id, session);
    return json(response, 200, {
      id: session.id,
      server: 'typescript',
      workspaceId: workspace.id,
      rootUri,
      capabilities: {
        textDocumentSync: 1,
        hoverProvider: true,
        completionProvider: { triggerCharacters: ['.'], resolveProvider: false },
        definitionProvider: true,
      },
      serverInfo: { name: 'stub-ls', version: '0' },
      reused: Boolean(existing),
    });
  }
  const session = lspSessions.get(body.session ?? '');
  if (!session) return error(response, 404, 'not_found', 'No such language server session.');
  switch (op) {
    case 'send': {
      const message = body.message;
      if (!message || message.jsonrpc !== '2.0')
        return error(response, 400, 'bad_message', 'A message is a JSON-RPC 2.0 object.');
      if (['initialize', 'initialized', 'shutdown', 'exit'].includes(message.method))
        return error(response, 400, 'bad_message', `${message.method} is the worker’s to send.`);
      lspAnswer(session, message, session.rootUri);
      return json(response, 202, { sent: true });
    }
    case 'events': {
      response.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
      });
      response.write(': open\n\n');
      session.stream = response;
      for (const text of session.backlog.splice(0)) response.write(`data: ${text}\n\n`);
      response.on('close', () => {
        if (session.stream === response) session.stream = null;
      });
      return;
    }
    case 'close':
      lspSessions.delete(session.id);
      return json(response, 200, { closed: true });
    default:
      return error(response, 404, 'unknown_operation');
  }
}

function handleWorkspaces(op, body, response) {
  if (op.startsWith('lsp/')) return handleLsp(op.slice('lsp/'.length), body, response);
  const scope = scopeOf(body);
  switch (op) {
    case 'clone': {
      if (
        !/^https:\/\/(bitbucket\.org|github\.com)\/.+\.git$/.test(body.cloneUrl ?? '') ||
        !body.gitProxy?.base
      ) {
        return error(response, 400, 'bad_request');
      }
      const now = new Date();
      const workspace = {
        id: randomUUID(),
        provider: body.provider,
        repoFullName: body.repoFullName,
        parentId: null,
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
    case 'worktree': {
      // A worktree of a ready clone: a workspace of its own, ready at once,
      // on the branch the chat asked for.
      const base = scope.workspaces.get(body.baseId ?? '');
      if (!base || base.parentId) return error(response, 404, 'not_found');
      if (base.status !== 'ready') return error(response, 409, 'not_ready');
      const existing = [...scope.workspaces.values()].find(
        (candidate) => candidate.parentId === base.id && candidate.branch === body.branch
      );
      if (existing) return json(response, 200, { workspace: wire(existing) });
      const now = new Date();
      const workspace = {
        ...base,
        id: randomUUID(),
        parentId: base.id,
        branch: body.branch,
        status: 'ready',
        createdAt: now.toISOString(),
        lastUsedAt: now.toISOString(),
        files: new Map(),
      };
      scope.workspaces.set(workspace.id, workspace);
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
      if (!TREE[path] && !workspace.extraEntries?.has(path)) {
        return error(response, 404, 'not_found', `${path} is not a directory.`);
      }
      const entries = pathsIn(path, workspace).map((entry) => ({
        ...entry,
        ignored: entry.ignored === true,
      }));
      return json(response, 200, { path, entries });
    }
    case 'rm': {
      const workspace = scope.workspaces.get(body.id ?? '');
      if (!workspace) return error(response, 404, 'not_found', 'No such workspace — see the list.');
      const path = body.path ?? '';
      const entry = entryAt(path, workspace);
      if (!entry) return error(response, 404, 'not_found', `No such file or folder: ${path}`);
      workspace.removed = workspace.removed ?? new Set();
      workspace.removed.add(path);
      workspace.files.delete(path);
      return json(response, 200, { path, deleted: true });
    }
    case 'mv': {
      const workspace = scope.workspaces.get(body.id ?? '');
      if (!workspace) return error(response, 404, 'not_found', 'No such workspace — see the list.');
      const from = body.from ?? '';
      const to = body.to ?? '';
      const entry = entryAt(from, workspace);
      if (!entry) return error(response, 404, 'not_found', `No such file or folder: ${from}`);
      if (entryAt(to, workspace))
        return error(response, 409, 'move_conflict', `${to} already exists.`);
      workspace.removed = workspace.removed ?? new Set();
      workspace.removed.add(from);
      workspace.extraEntries = workspace.extraEntries ?? new Map();
      const toDir = folderOf(to);
      if (!workspace.extraEntries.has(toDir)) workspace.extraEntries.set(toDir, []);
      workspace.extraEntries
        .get(toDir)
        .push({ path: to, kind: entry.kind, sizeBytes: entry.sizeBytes });
      if (workspace.files.has(from)) {
        workspace.files.set(to, workspace.files.get(from));
        workspace.files.delete(from);
      } else if (FILES[from] !== undefined) {
        workspace.files.set(to, Buffer.from(FILES[from], 'utf8'));
      }
      return json(response, 200, { from, to });
    }
    case 'git-discard': {
      const workspace = scope.workspaces.get(body.id ?? '');
      if (!workspace) return error(response, 404, 'not_found', 'No such workspace — see the list.');
      workspace.removed = new Set();
      workspace.extraEntries = new Map();
      workspace.files = new Map();
      return json(response, 200, { branch: workspace.branch });
    }
    case 'git-diff': {
      const workspace = scope.workspaces.get(body.id ?? '');
      if (!workspace) return error(response, 404, 'not_found', 'No such workspace — see the list.');
      if (workspace.status !== 'ready')
        return error(response, 409, 'not_ready', 'That workspace is still cloning.');
      const files = [{ path: 'src/billing.ts', added: 3, deleted: 1, status: 'modified' }];
      // A path the tree's own rm/mv removed reads as deleted here too,
      // same as the real worker's undetected-rename behaviour (no -M
      // passed to `git diff`, so a rename shows as a delete of the old
      // path plus a new untracked one) — but only for a path HEAD
      // actually had; removing one only ever created through this same
      // overlay (write, or mv's destination) leaves no trace, same as a
      // real `git diff` never lists an untracked file's removal.
      for (const path of workspace.removed ?? []) {
        if (wasTracked(path)) files.push({ path, added: 0, deleted: 1, status: 'deleted' });
      }
      return json(response, 200, {
        branch: workspace.branch,
        diff: body.statOnly ? '' : SAMPLE_DIFF,
        files,
        truncated: false,
      });
    }
    case 'read': {
      const workspace = scope.workspaces.get(body.id ?? '');
      if (!workspace) return error(response, 404, 'not_found', 'No such workspace — see the list.');
      if (workspace.status !== 'ready')
        return error(response, 409, 'not_ready', 'That workspace is still cloning.');
      const path = body.path ?? '';
      if (workspace.removed?.has(path))
        return error(response, 404, 'not_found', `No such file: ${path}`);
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
      const path = body.path ?? '';
      const created = !entryAt(path, workspace);
      const bytes = Buffer.from(body.content ?? '', 'utf8');
      workspace.files.set(path, bytes);
      if (created) {
        workspace.removed?.delete(path);
        const dir = folderOf(path);
        ensureDirChain(workspace, dir);
        workspace.extraEntries = workspace.extraEntries ?? new Map();
        if (!workspace.extraEntries.has(dir)) workspace.extraEntries.set(dir, []);
        workspace.extraEntries.get(dir).push({ path, kind: 'file', sizeBytes: bytes.byteLength });
      }
      return json(response, 200, { path, created, sizeBytes: bytes.byteLength });
    }
    case 'mkdir': {
      const workspace = scope.workspaces.get(body.id ?? '');
      if (!workspace) return error(response, 404, 'not_found', 'No such workspace — see the list.');
      const path = body.path ?? '';
      if (!path) return error(response, 400, 'bad_path', 'A folder path is required.');
      const existing = entryAt(path, workspace);
      if (existing) {
        if (existing.kind !== 'dir')
          return error(response, 409, 'bad_path', `${path} already exists.`);
        return json(response, 200, { path, created: false });
      }
      ensureDirChain(workspace, path);
      return json(response, 200, { path, created: true });
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
      if (!body.gitProxy?.base) return error(response, 400, 'bad_request');
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
      // A clone takes its worktrees with it.
      for (const [id, candidate] of scope.workspaces) {
        if (candidate.parentId === workspace.id) scope.workspaces.delete(id);
      }
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

/**
 * Spaces, per site: what creating one from a change request writes. A new
 * space's Administrators role starts with the group Jira's defaults would
 * put there, so applying has a member it must not add twice; components and
 * versions are refused twice by name, as Jira refuses them.
 */
const JIRA_SPACES = new Map();
let nextSpaceId = 30000;

function jiraSpaces(cloudId) {
  if (!JIRA_SPACES.has(cloudId)) JIRA_SPACES.set(cloudId, new Map());
  return JIRA_SPACES.get(cloudId);
}

function handleJiraSpaces(request, url, response, cloudId, path) {
  const spaces = jiraSpaces(cloudId);
  if (request.method === 'GET' && path === '/rest/api/3/projectvalidate/key') {
    const key = url.searchParams.get('key') ?? '';
    return json(response, 200, {
      errorMessages: [],
      errors: spaces.has(key)
        ? { projectKey: 'A project with that project key already exists.' }
        : {},
    });
  }
  if (path === '/rest/api/3/project' && request.method === 'POST') {
    void readBody(request).then((body) => {
      if (spaces.has(body.key)) {
        return jiraError(response, 400, 'A project with that project key already exists.');
      }
      const space = {
        id: String(nextSpaceId++),
        key: body.key,
        name: body.name,
        created: body,
        components: [],
        versions: [],
        roles: {
          10002: [
            {
              type: 'atlassian-group-role-actor',
              actorGroup: { name: 'ops-admins', displayName: 'ops-admins', groupId: 'g-admins' },
            },
          ],
        },
      };
      spaces.set(body.key, space);
      json(response, 201, { id: Number(space.id), key: space.key });
    });
    return;
  }
  const one = /^\/rest\/api\/3\/project\/([^/]+)$/.exec(path);
  if (one && request.method === 'GET') {
    const space = spaces.get(one[1]);
    return space ? json(response, 200, space) : jiraError(response, 404, 'No project.');
  }
  const listing = /^\/rest\/api\/3\/project\/([^/]+)\/(components|versions)$/.exec(path);
  if (listing && request.method === 'GET') {
    const space = spaces.get(listing[1]);
    return space ? json(response, 200, space[listing[2]]) : jiraError(response, 404, 'No project.');
  }
  if (
    (path === '/rest/api/3/component' || path === '/rest/api/3/version') &&
    request.method === 'POST'
  ) {
    void readBody(request).then((body) => {
      const component = path.endsWith('/component');
      const space = component
        ? spaces.get(body.project)
        : [...spaces.values()].find((candidate) => candidate.id === String(body.projectId));
      if (!space) return jiraError(response, 404, 'No project.');
      const list = component ? space.components : space.versions;
      if (list.some((item) => item.name.toLowerCase() === String(body.name).toLowerCase())) {
        return jiraError(response, 400, `${body.name} already exists in this project.`);
      }
      const row = { id: String(nextSpaceId++), ...body };
      list.push(row);
      json(response, 201, row);
    });
    return;
  }
  const role = /^\/rest\/api\/3\/project\/([^/]+)\/role\/(\d+)$/.exec(path);
  if (role) {
    const space = spaces.get(role[1]);
    if (!space) return jiraError(response, 404, 'No project.');
    const actors = (space.roles[role[2]] ??= []);
    if (request.method === 'GET') return json(response, 200, { id: Number(role[2]), actors });
    if (request.method === 'POST') {
      void readBody(request).then((body) => {
        const groups = [
          ...(body.groupId ?? []).map((groupId) => ({ groupId, name: groupId })),
          ...(body.group ?? []).map((name) => ({ groupId: '', name })),
        ];
        for (const group of groups) {
          const held = actors.some(
            (actor) =>
              actor.actorGroup &&
              ((group.groupId && actor.actorGroup.groupId === group.groupId) ||
                actor.actorGroup.name === group.name)
          );
          // Jira refuses a member twice; so does the stub, so a double add fails loudly.
          if (held) return jiraError(response, 400, `Group ${group.name} is already a member.`);
          actors.push({ type: 'atlassian-group-role-actor', actorGroup: group });
        }
        for (const accountId of body.user ?? []) {
          if (actors.some((actor) => actor.actorUser?.accountId === accountId)) {
            return jiraError(response, 400, `User ${accountId} is already a member.`);
          }
          actors.push({ type: 'atlassian-user-role-actor', actorUser: { accountId } });
        }
        json(response, 200, { id: Number(role[2]), actors });
      });
      return;
    }
  }
  return jiraError(response, 404, 'The stub does not answer that path.');
}

/**
 * Custom fields and screens, per site, for putting a field on a space: a
 * field search, creating a field (which, as Jira does since CHANGE-3019,
 * comes with a context for every space), its contexts and their projects,
 * and OPS's three screens and their tabs. A field is refused twice on a
 * screen, as Jira refuses it.
 */
const JIRA_FIELDS = new Map();
let nextFieldId = 10500;
let nextContextId = 20000;
let nextTabId = 430;

function jiraFieldSite(cloudId) {
  if (!JIRA_FIELDS.has(cloudId)) {
    JIRA_FIELDS.set(cloudId, {
      fields: [],
      contexts: new Map(),
      screens: new Map([
        [
          '40',
          {
            name: 'OPS: Edit/View',
            tabs: [
              { id: '400', name: 'Field Tab', fields: [] },
              { id: '401', name: 'Details', fields: [] },
            ],
          },
        ],
        ['41', { name: 'OPS: Create', tabs: [{ id: '410', name: 'Field Tab', fields: [] }] }],
        ['42', { name: 'Shared bug screen', tabs: [{ id: '420', name: 'Details', fields: [] }] }],
      ]),
    });
  }
  return JIRA_FIELDS.get(cloudId);
}

function paged(url, all) {
  const startAt = Number(url.searchParams.get('startAt') ?? '0');
  const maxResults = Number(url.searchParams.get('maxResults') ?? '50');
  const values = all.slice(startAt, startAt + maxResults);
  return {
    startAt,
    maxResults,
    total: all.length,
    isLast: startAt + values.length >= all.length,
    values,
  };
}

function handleJiraFields(request, url, response, cloudId, path) {
  const site = jiraFieldSite(cloudId);
  if (path === '/rest/api/3/field/search' && request.method === 'GET') {
    const query = (url.searchParams.get('query') ?? '').toLowerCase();
    return json(
      response,
      200,
      paged(
        url,
        site.fields.filter((field) => field.name.toLowerCase().includes(query))
      )
    );
  }
  if (path === '/rest/api/3/field' && request.method === 'POST') {
    void readBody(request).then((body) => {
      const field = {
        id: `customfield_${nextFieldId++}`,
        name: body.name,
        description: body.description,
        schema: { type: 'option', custom: body.type },
        searcherKey: body.searcherKey,
      };
      site.fields.push(field);
      site.contexts.set(field.id, [
        {
          id: String(nextContextId++),
          name: `Default Configuration Scheme for ${body.name}`,
          isGlobalContext: true,
          isAnyIssueType: true,
          projectIds: [],
        },
      ]);
      json(response, 201, field);
    });
    return;
  }
  const contexts = /^\/rest\/api\/3\/field\/([^/]+)\/context(\/projectmapping)?$/.exec(path);
  if (contexts) {
    const list = site.contexts.get(contexts[1]);
    if (!list) return jiraError(response, 404, 'The custom field was not found.');
    if (request.method === 'GET' && contexts[2]) {
      return json(
        response,
        200,
        paged(
          url,
          list.flatMap((context) =>
            context.isGlobalContext
              ? [{ contextId: context.id, isGlobalContext: true }]
              : context.projectIds.map((projectId) => ({ contextId: context.id, projectId }))
          )
        )
      );
    }
    if (request.method === 'GET') {
      return json(
        response,
        200,
        paged(
          url,
          list.map(({ id, name, isGlobalContext, isAnyIssueType }) => ({
            id,
            name,
            isGlobalContext,
            isAnyIssueType,
          }))
        )
      );
    }
    if (request.method === 'POST' && !contexts[2]) {
      void readBody(request).then((body) => {
        const projectIds = body.projectIds ?? [];
        if (list.some((context) => context.projectIds.some((id) => projectIds.includes(id)))) {
          return jiraError(
            response,
            400,
            'A project is already assigned to a context of this field.'
          );
        }
        const context = {
          id: String(nextContextId++),
          name: body.name,
          isGlobalContext: projectIds.length === 0,
          isAnyIssueType: (body.issueTypeIds ?? []).length === 0,
          projectIds,
          issueTypeIds: body.issueTypeIds ?? [],
        };
        list.push(context);
        // A new context starts with no options (the 1b fixtures seed three).
        JIRA_OPTIONS.set(`${cloudId}|${contexts[1]}|${context.id}`, []);
        json(response, 201, context);
      });
      return;
    }
  }
  const on = /^\/rest\/api\/3\/field\/([^/]+)\/screens$/.exec(path);
  if (on && request.method === 'GET') {
    const holding = [...site.screens.entries()].flatMap(([id, screen]) => {
      const tab = screen.tabs.find((candidate) => candidate.fields.includes(on[1]));
      return tab
        ? [{ id: Number(id), name: screen.name, tab: { id: Number(tab.id), name: tab.name } }]
        : [];
    });
    return json(response, 200, paged(url, holding));
  }
  const tabs = /^\/rest\/api\/3\/screens\/([^/]+)\/tabs(?:\/([^/]+)\/fields)?$/.exec(path);
  if (tabs) {
    const screen = site.screens.get(tabs[1]);
    if (!screen) return jiraError(response, 404, 'The screen was not found.');
    if (request.method === 'GET' && !tabs[2]) {
      return json(
        response,
        200,
        screen.tabs.map((tab) => ({ id: Number(tab.id), name: tab.name }))
      );
    }
    const tab = screen.tabs.find((candidate) => candidate.id === tabs[2]);
    if (!tab) return jiraError(response, 404, 'The screen tab was not found.');
    if (request.method === 'GET') {
      return json(
        response,
        200,
        tab.fields.map((id) => ({ id, name: id }))
      );
    }
    if (request.method === 'POST') {
      void readBody(request).then((body) => {
        if (screen.tabs.some((candidate) => candidate.fields.includes(body.fieldId))) {
          return jiraError(response, 400, 'The field is already on the screen.');
        }
        tab.fields.push(body.fieldId);
        json(response, 200, { id: body.fieldId, name: body.fieldId });
      });
      return;
    }
  }
  // Changes to a screen (lib/jira-admin/screen-changes.ts): a field off a
  // tab or moved on it, a tab added or renamed, the screen renamed.
  const tabField =
    /^\/rest\/api\/3\/screens\/([^/]+)\/tabs\/([^/]+)\/fields\/([^/]+)(\/move)?$/.exec(path);
  if (tabField) {
    const screen = site.screens.get(tabField[1]);
    const tab = screen?.tabs.find((candidate) => candidate.id === tabField[2]);
    if (!screen || !tab) return jiraError(response, 404, 'The screen tab was not found.');
    const index = tab.fields.indexOf(tabField[3]);
    if (index < 0) return jiraError(response, 404, 'The field is not on the screen tab.');
    if (request.method === 'DELETE' && !tabField[4]) {
      tab.fields.splice(index, 1);
      response.statusCode = 204;
      return response.end();
    }
    if (request.method === 'POST' && tabField[4]) {
      void readBody(request).then((body) => {
        const [field] = tab.fields.splice(index, 1);
        const at =
          body.position === 'First'
            ? 0
            : body.position === 'Last'
              ? tab.fields.length
              : body.position === 'Earlier'
                ? Math.max(0, index - 1)
                : Math.min(tab.fields.length, index + 1);
        tab.fields.splice(at, 0, field);
        response.statusCode = 204;
        response.end();
      });
      return;
    }
  }
  const tabOne = /^\/rest\/api\/3\/screens\/([^/]+)\/tabs\/([^/]+)$/.exec(path);
  if (tabOne && request.method === 'PUT') {
    const screen = site.screens.get(tabOne[1]);
    const tab = screen?.tabs.find((candidate) => candidate.id === tabOne[2]);
    if (!tab) return jiraError(response, 404, 'The screen tab was not found.');
    void readBody(request).then((body) => {
      tab.name = body.name;
      json(response, 200, { id: Number(tab.id), name: tab.name });
    });
    return;
  }
  const tabList = /^\/rest\/api\/3\/screens\/([^/]+)\/tabs$/.exec(path);
  if (tabList && request.method === 'POST') {
    const screen = site.screens.get(tabList[1]);
    if (!screen) return jiraError(response, 404, 'The screen was not found.');
    void readBody(request).then((body) => {
      if (screen.tabs.some((tab) => tab.name.toLowerCase() === String(body.name).toLowerCase())) {
        return jiraError(response, 400, 'A tab with that name already exists.');
      }
      const tab = { id: String(nextTabId++), name: body.name, fields: [] };
      screen.tabs.push(tab);
      json(response, 200, { id: Number(tab.id), name: tab.name });
    });
    return;
  }
  const screenOne = /^\/rest\/api\/3\/screens\/([^/]+)$/.exec(path);
  if (screenOne && request.method === 'PUT') {
    const screen = site.screens.get(screenOne[1]);
    if (!screen) return jiraError(response, 404, 'The screen was not found.');
    void readBody(request).then((body) => {
      screen.name = body.name;
      json(response, 200, { id: Number(screenOne[1]), name: screen.name });
    });
    return;
  }
  return jiraError(response, 404, 'The stub does not answer that path.');
}

/**
 * Work types and the schemes a space runs on, per site, for adding a work
 * type to OPS (lib/jira-admin/work-type.ts): the site's work types and
 * icons, OPS's work type, screens and workflow schemes with their
 * mappings, and the bulk workflow scheme read and update, which carries a
 * version Jira bumps on every change. And a service desk's request types,
 * for HELP (lib/jira-admin/request-type.ts): the create takes the JSM
 * grant, through the same stand-in.
 */
const JIRA_WORK_TYPES = new Map();
let nextWorkTypeId = 10050;
let nextRequestTypeId = 11000;

function jiraWorkTypeSite(cloudId) {
  if (!JIRA_WORK_TYPES.has(cloudId)) {
    JIRA_WORK_TYPES.set(cloudId, {
      types: [
        { id: '10001', name: 'Task', subtask: false, hierarchyLevel: 0, avatarId: 10318 },
        { id: '10002', name: 'Bug', subtask: false, hierarchyLevel: 0, avatarId: 10303 },
      ],
      // Scheme 11, OPS's — and HR's, so a proposal names HR.
      issueTypeScheme: { id: '11', name: 'OPS work types', issueTypeIds: ['10001', '10002'] },
      screensScheme: {
        id: '12',
        name: 'OPS screens',
        mappings: [
          { issueTypeId: '10002', screenSchemeId: '31' },
          { issueTypeId: 'default', screenSchemeId: '30' },
        ],
      },
      workflowScheme: {
        id: '13',
        name: 'OPS workflows',
        version: { id: 'v-1', versionNumber: 1 },
        defaultWorkflow: { id: 'wf-simple', name: 'Simple workflow' },
        workflowsForIssueTypes: [
          { workflow: { id: 'wf-bug', name: 'Bug workflow' }, issueTypeIds: ['10002'] },
        ],
      },
      requestTypes: [],
    });
  }
  return JIRA_WORK_TYPES.get(cloudId);
}

function handleJiraWorkTypes(request, url, response, cloudId, path) {
  const site = jiraWorkTypeSite(cloudId);
  if (path === '/rest/api/3/issuetype' && request.method === 'GET') {
    return json(response, 200, site.types);
  }
  if (path === '/rest/api/3/issuetype' && request.method === 'POST') {
    void readBody(request).then((body) => {
      if (site.types.some((type) => type.name.toLowerCase() === String(body.name).toLowerCase())) {
        return jiraError(response, 409, 'An issue type with this name already exists.');
      }
      const type = {
        id: String(nextWorkTypeId++),
        name: body.name,
        description: body.description,
        subtask: body.hierarchyLevel === -1,
        hierarchyLevel: body.hierarchyLevel ?? 0,
        avatarId: 10300,
      };
      site.types.push(type);
      json(response, 201, type);
    });
    return;
  }
  const typeOne = /^\/rest\/api\/3\/issuetype\/([^/]+)$/.exec(path);
  if (typeOne && request.method === 'PUT') {
    const type = site.types.find((candidate) => candidate.id === typeOne[1]);
    if (!type) return jiraError(response, 404, 'The issue type was not found.');
    void readBody(request).then((body) => {
      if (body.avatarId !== undefined) type.avatarId = body.avatarId;
      if (body.name) type.name = body.name;
      if (body.description !== undefined) type.description = body.description;
      json(response, 200, type);
    });
    return;
  }
  if (path === '/rest/api/3/avatar/issuetype/system' && request.method === 'GET') {
    return json(response, 200, {
      system: [
        { id: '10303', fileName: '10303_bug.png', urls: { '48x48': 'https://stub/bug.png' } },
        { id: '10315', fileName: '10315_story.png', urls: { '48x48': 'https://stub/story.png' } },
        { id: '10318', fileName: '10318_task.png', urls: { '48x48': 'https://stub/task.png' } },
      ],
    });
  }
  if (path === '/rest/api/3/project/search' && request.method === 'GET') {
    return json(
      response,
      200,
      paged(url, [
        { id: '10000', key: 'OPS' },
        { id: '10300', key: 'HR' },
      ])
    );
  }
  if (path === '/rest/api/3/issuetypescheme/project' && request.method === 'GET') {
    const scheme = site.issueTypeScheme;
    const wanted = url.searchParams.getAll('projectId');
    const projectIds = ['10000', '10300'].filter((id) => wanted.includes(id));
    return json(
      response,
      200,
      paged(
        url,
        projectIds.length > 0
          ? [{ issueTypeScheme: { id: scheme.id, name: scheme.name }, projectIds }]
          : []
      )
    );
  }
  if (path === '/rest/api/3/issuetypescheme/mapping' && request.method === 'GET') {
    const scheme = site.issueTypeScheme;
    return json(
      response,
      200,
      paged(
        url,
        scheme.issueTypeIds.map((issueTypeId) => ({ issueTypeSchemeId: scheme.id, issueTypeId }))
      )
    );
  }
  const addToScheme = /^\/rest\/api\/3\/issuetypescheme\/([^/]+)\/issuetype$/.exec(path);
  if (addToScheme && request.method === 'PUT') {
    if (addToScheme[1] !== site.issueTypeScheme.id) {
      return jiraError(response, 404, 'The issue type scheme was not found.');
    }
    void readBody(request).then((body) => {
      for (const id of body.issueTypeIds ?? []) {
        if (site.issueTypeScheme.issueTypeIds.includes(id)) {
          return jiraError(response, 400, 'The issue type is already in the scheme.');
        }
        site.issueTypeScheme.issueTypeIds.push(id);
      }
      response.statusCode = 204;
      response.end();
    });
    return;
  }
  if (path === '/rest/api/3/issuetypescreenscheme/project' && request.method === 'GET') {
    const scheme = site.screensScheme;
    return json(response, 200, {
      values: [
        { issueTypeScreenScheme: { id: scheme.id, name: scheme.name }, projectIds: ['10000'] },
      ],
    });
  }
  if (path === '/rest/api/3/issuetypescreenscheme/mapping' && request.method === 'GET') {
    const scheme = site.screensScheme;
    return json(
      response,
      200,
      paged(
        url,
        scheme.mappings.map((mapping) => ({ issueTypeScreenSchemeId: scheme.id, ...mapping }))
      )
    );
  }
  const screensMapping = /^\/rest\/api\/3\/issuetypescreenscheme\/([^/]+)\/mapping$/.exec(path);
  if (screensMapping && request.method === 'PUT') {
    if (screensMapping[1] !== site.screensScheme.id) {
      return jiraError(response, 404, 'The issue type screen scheme was not found.');
    }
    void readBody(request).then((body) => {
      for (const mapping of body.issueTypeMappings ?? []) {
        if (site.screensScheme.mappings.some((held) => held.issueTypeId === mapping.issueTypeId)) {
          return jiraError(response, 400, 'The issue type is mapped already.');
        }
        site.screensScheme.mappings.push({
          issueTypeId: mapping.issueTypeId,
          screenSchemeId: mapping.screenSchemeId,
        });
      }
      response.statusCode = 204;
      response.end();
    });
    return;
  }
  if (path === '/rest/api/3/screenscheme' && request.method === 'GET') {
    const names = { 30: 'OPS screen scheme', 31: 'Bug screen scheme' };
    const ids = url.searchParams.getAll('id');
    return json(response, 200, {
      isLast: true,
      values: ids.filter((id) => names[id]).map((id) => ({ id: Number(id), name: names[id] })),
    });
  }
  if (path === '/rest/api/3/workflowscheme/project' && request.method === 'GET') {
    const scheme = site.workflowScheme;
    return json(response, 200, {
      values: [{ workflowScheme: { id: scheme.id, name: scheme.name }, projectIds: ['10000'] }],
    });
  }
  if (path === '/rest/api/3/workflowscheme/read' && request.method === 'POST') {
    void readBody(request).then((body) => {
      const scheme = site.workflowScheme;
      json(
        response,
        200,
        (body.workflowSchemeIds ?? []).includes(scheme.id)
          ? [
              {
                id: scheme.id,
                name: scheme.name,
                version: scheme.version,
                defaultWorkflow: scheme.defaultWorkflow,
                workflowsForIssueTypes: scheme.workflowsForIssueTypes,
              },
            ]
          : []
      );
    });
    return;
  }
  if (path === '/rest/api/3/workflowscheme/update' && request.method === 'POST') {
    void readBody(request).then((body) => {
      const scheme = site.workflowScheme;
      if (body.id !== scheme.id)
        return jiraError(response, 404, 'The workflow scheme was not found.');
      if (body.version?.versionNumber !== scheme.version.versionNumber) {
        return jiraError(response, 409, 'The workflow scheme has changed since it was read.');
      }
      const known = new Map([
        ['wf-bug', 'Bug workflow'],
        ['wf-simple', 'Simple workflow'],
        ['wf-incident', 'Incident workflow'],
      ]);
      scheme.workflowsForIssueTypes = (body.workflowsForIssueTypes ?? []).map((item) => ({
        workflow: { id: item.workflowId, name: known.get(item.workflowId) ?? item.workflowId },
        issueTypeIds: item.issueTypeIds,
      }));
      scheme.version = {
        id: `v-${scheme.version.versionNumber + 1}`,
        versionNumber: scheme.version.versionNumber + 1,
      };
      json(response, 200, {});
    });
    return;
  }
  if (path === '/rest/api/3/workflows/search' && request.method === 'GET') {
    const query = (url.searchParams.get('queryString') ?? '').toLowerCase();
    const all = [
      { id: 'wf-bug', name: 'Bug workflow' },
      { id: 'wf-simple', name: 'Simple workflow' },
      { id: 'wf-incident', name: 'Incident workflow' },
    ];
    return json(
      response,
      200,
      paged(
        url,
        all.filter((wf) => wf.name.toLowerCase().includes(query))
      )
    );
  }
  // The service desk for HELP, on the servicedeskapi.
  const desk = /^\/rest\/servicedeskapi\/servicedesk\/([^/]+)$/.exec(path);
  if (desk && request.method === 'GET') {
    if (desk[1] !== 'HELP' && desk[1] !== '3') return jiraError(response, 404, 'No service desk.');
    return json(response, 200, {
      id: '3',
      projectId: '10100',
      projectKey: 'HELP',
      projectName: 'Help desk',
    });
  }
  const requestTypes = /^\/rest\/servicedeskapi\/servicedesk\/([^/]+)\/requesttype$/.exec(path);
  if (requestTypes) {
    if (requestTypes[1] !== '3') return jiraError(response, 404, 'No service desk.');
    if (request.method === 'GET') {
      const query = (url.searchParams.get('searchQuery') ?? '').toLowerCase();
      return json(response, 200, {
        isLastPage: true,
        values: site.requestTypes.filter((type) => type.name.toLowerCase().includes(query)),
      });
    }
    if (request.method === 'POST') {
      if (request.headers['x-experimentalapi'] !== 'opt-in') {
        return json(response, 412, {
          errorMessage: 'This API is experimental; opt in with X-ExperimentalApi.',
        });
      }
      void readBody(request).then((body) => {
        if (
          site.requestTypes.some(
            (type) => type.name.toLowerCase() === String(body.name).toLowerCase()
          )
        ) {
          return json(response, 400, {
            errorMessage: 'A request type with this name already exists.',
          });
        }
        const type = {
          id: String(nextRequestTypeId++),
          name: body.name,
          description: body.description ?? '',
          helpText: body.helpText ?? '',
          issueTypeId: body.issueTypeId,
          groupIds: [],
          icon: { id: '10527' },
        };
        site.requestTypes.push(type);
        json(response, 200, type);
      });
      return;
    }
  }
  return jiraError(response, 404, 'The stub does not answer that path.');
}

/**
 * The Automation REST API, stood in for: reached through
 * JIRA_AUTOMATION_API_BASE_URL on the person's Atlassian API token, which
 * the delegate sends as HTTP Basic (email:token). A token that does not
 * look like one (ATATT…) is refused with a 401, the way Atlassian refuses
 * a revoked one — so the token route's "check it through the delegate"
 * step has something to check against. Two rules per site, in memory.
 */
const AUTOMATION = new Map();
let nextRuleId = 100;

function automationSite(cloudId) {
  if (!AUTOMATION.has(cloudId)) {
    AUTOMATION.set(cloudId, {
      lastAuthorization: null,
      rules: new Map([
        [
          'rule-1',
          {
            uuid: 'rule-1',
            name: 'Escalate outages',
            state: 'ENABLED',
            description: 'Pages on-call',
            labels: ['ops'],
            ruleScopeARIs: [`ari:cloud:jira:${cloudId}:project/10000`],
            created: 1700000000000,
            updated: 1700000000000,
            authorAccountId: 'acct-1',
            actor: { type: 'ACCOUNT_ID', actor: 'acct-1' },
            trigger: { id: 't-1', type: 'jira.issue.event.trigger:created', value: {} },
            components: [
              { id: 'c-1', type: 'jira.issue.comment', value: { comment: 'Paging' }, children: [] },
            ],
          },
        ],
        [
          'rule-2',
          {
            uuid: 'rule-2',
            name: 'Nightly tidy',
            state: 'DISABLED',
            description: '',
            labels: [],
            ruleScopeARIs: [],
            created: 1700000000000,
            updated: 1700000000000,
            authorAccountId: 'acct-1',
            actor: { type: 'ACCOUNT_ID', actor: 'acct-1' },
            trigger: { id: 't-2', type: 'jira.schedule.trigger', value: {} },
            components: [],
          },
        ],
      ]),
    });
  }
  return AUTOMATION.get(cloudId);
}

function summaryOfRule(rule) {
  const { trigger, components, ...summary } = rule;
  void trigger;
  void components;
  return summary;
}

function handleAutomation(request, url, response) {
  // The real path shape, product then site: …/automation/public/jira/{cloudId}/rest/v1/….
  const match = /^\/automation\/jira\/([^/]+)(\/.*)$/.exec(url.pathname);
  if (!match) return json(response, 404, { message: 'The stub does not answer that path.' });
  const [, cloudId, path] = match;
  const site = automationSite(cloudId);
  // The test reads what the delegate sent, without a token of its own.
  if (path === '/__last-authorization' && request.method === 'GET') {
    return json(response, 200, { authorization: site.lastAuthorization });
  }
  const authorization = request.headers.authorization ?? '';
  site.lastAuthorization = authorization;
  const basic = /^Basic (.+)$/.exec(authorization);
  const decoded = basic ? Buffer.from(basic[1], 'base64').toString('utf8') : '';
  const token = decoded.includes(':') ? decoded.slice(decoded.indexOf(':') + 1) : '';
  if (!decoded.includes('@') || !token.startsWith('ATATT')) {
    return json(response, 401, { message: 'Unauthorized; scope does not match' });
  }
  if (path === '/rest/v1/rule/summary' && (request.method === 'GET' || request.method === 'POST')) {
    const answer = (filter) => {
      const rules = [...site.rules.values()]
        .filter((rule) => !filter.state || rule.state === filter.state)
        .filter((rule) => !filter.scope || rule.ruleScopeARIs.includes(filter.scope))
        .map(summaryOfRule);
      json(response, 200, { data: rules, links: {} });
    };
    if (request.method === 'GET') return answer({});
    void readBody(request).then((body) => answer(body ?? {}));
    return;
  }
  if (path === '/rest/v1/rule' && request.method === 'POST') {
    void readBody(request).then((body) => {
      const rule = body?.rule;
      if (!rule || !rule.name || !rule.trigger || !Array.isArray(rule.components)) {
        return json(response, 400, { message: 'A rule needs a name, a trigger and components.' });
      }
      const uuid = `rule-${nextRuleId++}`;
      site.rules.set(uuid, { ...rule, uuid, created: Date.now(), updated: Date.now() });
      json(response, 201, { ruleUuid: uuid });
    });
    return;
  }
  const one = /^\/rest\/v1\/rule\/([^/?]+)(\/state)?(?:\?.*)?$/.exec(path);
  if (one) {
    const rule = site.rules.get(one[1]);
    if (!rule) return json(response, 404, { message: 'Rule not found.' });
    if (request.method === 'GET' && !one[2]) {
      return json(response, 200, { rule, connections: [] });
    }
    if (request.method === 'PUT' && one[2]) {
      void readBody(request).then((body) => {
        rule.state = body?.value === 'DISABLED' ? 'DISABLED' : 'ENABLED';
        rule.updated = Date.now();
        json(response, 200, {});
      });
      return;
    }
    if (request.method === 'PUT' && !one[2]) {
      void readBody(request).then((body) => {
        if (!body?.rule) return json(response, 400, { message: 'A rule is required.' });
        site.rules.set(rule.uuid, { ...body.rule, uuid: rule.uuid, updated: Date.now() });
        json(response, 200, { ruleUuid: rule.uuid });
      });
      return;
    }
  }
  const run = /^\/rest\/v1\/rule\/manual\/([^/]+)\/invocation$/.exec(path);
  if (run && request.method === 'POST') {
    const rule = site.rules.get(run[1]);
    if (!rule) return json(response, 404, { message: 'Rule not found.' });
    void readBody(request).then((body) => {
      const answers = {};
      for (const object of body?.objects ?? []) answers[object] = 'SUCCESS';
      json(response, 200, answers);
    });
    return;
  }
  return json(response, 404, { message: 'The stub does not answer that path.' });
}

function handleJiraAdmin(request, url, response) {
  const workTypes =
    /^\/jira\/([^/]+)(\/rest\/api\/3\/(?:issuetype|avatar|issuetypescheme|issuetypescreenscheme|screenscheme|workflowscheme|workflows|project\/search)(?:\/.*)?|\/rest\/servicedeskapi\/.*)$/.exec(
      url.pathname
    );
  if (workTypes) return handleJiraWorkTypes(request, url, response, workTypes[1], workTypes[2]);
  const site =
    /^\/jira\/([^/]+)(\/rest\/api\/3\/(?:project|projectvalidate|component|version)(?:\/.*)?)$/.exec(
      url.pathname
    );
  if (site) return handleJiraSpaces(request, url, response, site[1], site[2]);
  const match =
    /^\/jira\/([^/]+)\/rest\/api\/3\/field\/([^/]+)\/context\/([^/]+)\/option(\/move)?$/.exec(
      url.pathname
    );
  const fields = /^\/jira\/([^/]+)(\/rest\/api\/3\/(?:field|screens)(?:\/.*)?)$/.exec(url.pathname);
  if (!match && fields) return handleJiraFields(request, url, response, fields[1], fields[2]);
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

/**
 * An Anthropic Messages endpoint, stood in for: a spec that needs a chat
 * turn to actually run (a preview card's decision opening the model's
 * reply, widget-card.spec.ts) seeds its model config with
 * `base_url = http://127.0.0.1:8092/anthropic`, and the app's adapter
 * (packages/agent-llm/src/anthropic.ts) streams from here instead of the
 * network. The reply is one text block that quotes the last user
 * message's first line, so a spec can assert the model was handed what
 * it expects. The frames are the ones the adapter parses — message_start,
 * content_block_start/delta/stop, message_delta, message_stop — and
 * nothing more.
 */
function handleAnthropic(request, url, response) {
  if (request.method !== 'POST' || url.pathname !== '/anthropic/v1/messages') {
    return json(response, 404, { type: 'error', error: { type: 'not_found_error' } });
  }
  void readBody(request).then((body) => {
    const messages = Array.isArray(body.messages) ? body.messages : [];
    const lastUser = [...messages].reverse().find((message) => message?.role === 'user');
    const content = lastUser?.content;
    const text =
      typeof content === 'string'
        ? content
        : Array.isArray(content)
          ? content
              .filter((block) => block?.type === 'text' && typeof block.text === 'string')
              .map((block) => block.text)
              .join('\n')
          : '';
    const firstLine = text.split('\n').find((line) => line.trim()) ?? '';
    const reply = `Stub model: I saw “${firstLine.trim()}”`;
    // A scripted tool call: a user message of the form
    // `[[call <tool> <json arguments>]]` is answered with that one
    // tool_use, streamed the way the real API streams it (an empty input
    // on the start frame, the arguments as one input_json_delta), so a
    // spec can have the model reach for a tool without a real model. The
    // round after — the tool's result comes back as a tool_result block,
    // never as text — gets the plain text reply below.
    const scripted = /^\[\[call\s+([A-Za-z0-9_.-]+)\s*(\{[\s\S]*\})?\s*\]\]$/.exec(
      firstLine.trim()
    );
    const frames = scripted
      ? [
          { type: 'message_start', message: { usage: { input_tokens: 12, output_tokens: 1 } } },
          {
            type: 'content_block_start',
            index: 0,
            content_block: {
              type: 'tool_use',
              id: `toolu_stub_${Date.now()}`,
              name: scripted[1],
              input: {},
            },
          },
          {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'input_json_delta', partial_json: scripted[2] ?? '{}' },
          },
          { type: 'content_block_stop', index: 0 },
          {
            type: 'message_delta',
            delta: { stop_reason: 'tool_use' },
            usage: { output_tokens: 8 },
          },
          { type: 'message_stop' },
        ]
      : [
          { type: 'message_start', message: { usage: { input_tokens: 12, output_tokens: 1 } } },
          { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
          { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: reply } },
          { type: 'content_block_stop', index: 0 },
          {
            type: 'message_delta',
            delta: { stop_reason: 'end_turn' },
            usage: { output_tokens: 8 },
          },
          { type: 'message_stop' },
        ];
    response.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
    });
    for (const frame of frames) {
      response.write(`event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`);
    }
    response.end();
  });
}

const server = createServer((request, response) => {
  const url = new URL(request.url ?? '/', 'http://stub.internal');
  // The worker's /health names what it can do (apps/worker-sandbox
  // features.ts); the app resolves each organization's features from this
  // and the organization's own settings.
  if (request.method === 'GET' && url.pathname === '/health')
    return json(response, 200, {
      ok: true,
      capabilities: {
        browser: true,
        charts: true,
        workspaces: true,
        services: true,
        scripts: 'isolated',
      },
    });
  // The model, stood in for: a seeded model config points its base_url here.
  if (url.pathname.startsWith('/anthropic/')) return handleAnthropic(request, url, response);
  // Bitbucket, stood in for: the app is pointed here with
  // BITBUCKET_API_BASE_URL, so the picker's browsing and a project page's
  // README are exercised without the network.
  if (url.pathname.startsWith('/bitbucket/2.0/')) return handleBitbucket(request, url, response);
  // Jira administration's option endpoints, for applying change requests.
  if (url.pathname.startsWith('/jira/')) return handleJiraAdmin(request, url, response);
  if (url.pathname.startsWith('/automation/')) return handleAutomation(request, url, response);
  if (request.headers.authorization !== `Bearer ${API_KEY}`) {
    return error(response, 401, 'unauthorized');
  }
  if (request.method !== 'POST') return error(response, 405, 'method_not_allowed');
  // The one verb whose body is the file: it lands in memory, by path.
  if (url.pathname === '/v1/workspaces/upload') {
    const query = Object.fromEntries(url.searchParams);
    if (!query.subject) return error(response, 400, 'bad_request');
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
    // The rule verbs are the organization's: no subject.
    if (op.startsWith('services/rules/')) {
      return handleServices(op.slice('services/'.length), body, response);
    }
    if (!body.subject) return error(response, 400, 'bad_request');
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
