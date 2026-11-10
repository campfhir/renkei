/**
 * Code project previews — a project's own server (a dev server, an API,
 * a static site) started in its checkout and reached from outside the
 * sandbox through the web app, so a person can open what a chat built
 * in a browser, and a webhook or a phone can reach it. The pure half:
 * bounds, the vocabulary the worker and the web app both speak, the port
 * pool, what a preview's process is told about where it is, and how the
 * two proxy hops shape headers. Processes, ports and the proxy itself
 * are apps/worker-sandbox's (src/previews.ts); the routes and the tools
 * are apps/web's.
 *
 * Ports are a system pool, never a preview's pick: PREVIEW_PORT_MIN to
 * PREVIEW_PORT_MAX on the worker, handed out lowest-free-first. A
 * preview declares the ports it needs by NAME (`app` alone by default; a
 * UI and an API together are `['web', 'api']` on one preview) and is told
 * each one's number — `PORT` for the first, `PORT_<NAME>` for every one —
 * so a project's dev script binds what it was given rather than what it
 * hard-codes. Each named port has a relay address of its own and, when
 * the preview is public, a share token of its own.
 *
 * A preview is working state, like a service beside the checkout: it
 * lives on the worker that started it, in memory and in its process
 * table, for a while past its last request, and no longer than the
 * worker itself.
 */

import { SERVICE_NAME_PATTERN } from './services';

// ─── Bounds ─────────────────────────────────────────────────────────────────

/** Previews one project may have up at once. */
export const PREVIEW_MAX_PER_SUBJECT = 3;
/** A preview's lifetime since its last request through the proxy (or its start). */
export const PREVIEW_TTL_MS = 4 * 60 * 60_000;
/** The system's preview port pool: every preview's ports come from here, lowest free first. */
export const PREVIEW_PORT_MIN = 10_000;
export const PREVIEW_PORT_MAX = 10_050;
/** Named ports one preview may hold. */
export const PREVIEW_PORTS_MAX = 8;
/** The name a preview's one port has when it declares none. */
export const PREVIEW_DEFAULT_PORT_NAME = 'app';
export const PREVIEW_PORT_NAME_PATTERN = /^[a-z][a-z0-9-]{0,15}$/;
/** How long a start waits for the server to accept connections before answering anyway. */
export const PREVIEW_START_WAIT_DEFAULT_MS = 60_000;
export const PREVIEW_START_WAIT_MAX_MS = 5 * 60_000;
/** Lines of a preview's output the worker keeps, newest winning. */
export const PREVIEW_LOG_MAX_LINES = 2_000;
export const PREVIEW_LOGS_DEFAULT_LINES = 200;
export const PREVIEW_LOGS_MAX_CHARS = 40_000;
/** One proxied request's patience for the server's headers. */
export const PREVIEW_PROXY_TIMEOUT_MS = 120_000;
/** A share token: 32 random bytes, base64url — the whole secret of a public link. */
export const PREVIEW_TOKEN_BYTES = 32;
export const PREVIEW_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export const PREVIEW_NAME_PATTERN = SERVICE_NAME_PATTERN;

export type PreviewStatus = 'starting' | 'running' | 'exited';

/** One of a preview's named ports: its number from the pool and how it is reached. */
export interface PreviewPortBinding {
  name: string;
  port: number;
  /** The share token for this port, when the preview is public; null otherwise. */
  token: string | null;
  /** Where the web app serves this port — the public address when it has a token. */
  url: string;
}

/** One preview as the worker describes it. */
export interface SandboxPreviewSummary {
  id: string;
  name: string;
  /** The checkout (workspace id) the command runs in. */
  workspaceId: string;
  command: string;
  /** The ports, first one primary: `PORT`, the `…/app/` address. */
  ports: PreviewPortBinding[];
  status: PreviewStatus;
  /** The process's exit, once it has one. */
  exitCode: number | null;
  signal: string | null;
  startedAt: Date;
  lastUsedAt: Date;
  expiresAt: Date;
}

// ─── Validators ─────────────────────────────────────────────────────────────

export function validatePreviewName(
  input: unknown
): { ok: true; name: string } | { ok: false; message: string } {
  const name = typeof input === 'string' ? input.trim() : '';
  if (!PREVIEW_NAME_PATTERN.test(name)) {
    return {
      ok: false,
      message:
        'A preview name is lower-case letters, digits and hyphens, starting with a letter (at most 32 characters) — web, api, docs.',
    };
  }
  return { ok: true, name };
}

/**
 * The port names a preview declares: none means one, `app`; otherwise
 * short lower-case names, unique, at most PREVIEW_PORTS_MAX, the first
 * being the primary.
 */
export function validatePreviewPorts(
  input: unknown
): { ok: true; ports: string[] } | { ok: false; message: string } {
  if (input === undefined || input === null)
    return { ok: true, ports: [PREVIEW_DEFAULT_PORT_NAME] };
  if (!Array.isArray(input) || input.length === 0) {
    return { ok: false, message: 'ports is a list of port names — ["web", "api"].' };
  }
  if (input.length > PREVIEW_PORTS_MAX) {
    return { ok: false, message: `A preview holds at most ${PREVIEW_PORTS_MAX} ports.` };
  }
  const ports: string[] = [];
  for (const raw of input) {
    const name = typeof raw === 'string' ? raw.trim() : '';
    if (!PREVIEW_PORT_NAME_PATTERN.test(name)) {
      return {
        ok: false,
        message:
          'A port name is lower-case letters, digits and hyphens, starting with a letter (at most 16 characters).',
      };
    }
    if (ports.includes(name)) return { ok: false, message: `Port name ${name} is repeated.` };
    ports.push(name);
  }
  return { ok: true, ports };
}

export function validatePreviewPortName(
  input: unknown
): { ok: true; name: string } | { ok: false; message: string } {
  const name = typeof input === 'string' ? input.trim() : '';
  if (!PREVIEW_PORT_NAME_PATTERN.test(name)) {
    return { ok: false, message: 'Not a port name.' };
  }
  return { ok: true, name };
}

/** How long a start may wait for the server to listen, bounded. */
export function previewWaitMs(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return PREVIEW_START_WAIT_DEFAULT_MS;
  }
  return Math.min(PREVIEW_START_WAIT_MAX_MS, Math.max(1_000, Math.floor(value)));
}

export function previewLogLines(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return PREVIEW_LOGS_DEFAULT_LINES;
  }
  return Math.min(PREVIEW_LOG_MAX_LINES, Math.max(1, Math.floor(value)));
}

export function isPreviewToken(value: unknown): value is string {
  return typeof value === 'string' && PREVIEW_TOKEN_PATTERN.test(value);
}

export interface PreviewPortRange {
  min: number;
  max: number;
}

export const DEFAULT_PREVIEW_PORT_RANGE: PreviewPortRange = {
  min: PREVIEW_PORT_MIN,
  max: PREVIEW_PORT_MAX,
};

/**
 * The pool as the worker's environment names it (`SANDBOX_PREVIEW_PORTS`,
 * `10000-10050`): two unprivileged ports, low to high, at most a few
 * hundred wide — the pool is a system limit, not a free range. Empty
 * means the default; a malformed value is a refusal with why, for the
 * boot log, rather than a silent default.
 */
export function parsePreviewPortRange(
  value: string | undefined,
  fallback: PreviewPortRange = DEFAULT_PREVIEW_PORT_RANGE
): { ok: true; range: PreviewPortRange } | { ok: false; message: string } {
  const text = (value ?? '').trim();
  if (!text) return { ok: true, range: fallback };
  const match = text.match(/^(\d{4,5})\s*[-–:]\s*(\d{4,5})$/);
  if (!match) {
    return {
      ok: false,
      message: `SANDBOX_PREVIEW_PORTS is two ports, low-high (10000-10050), not ${JSON.stringify(text)}.`,
    };
  }
  const min = Number(match[1]);
  const max = Number(match[2]);
  if (min < 1_024 || max > 65_535 || max < min) {
    return {
      ok: false,
      message: `SANDBOX_PREVIEW_PORTS must lie within 1024-65535, low first: ${text}.`,
    };
  }
  if (max - min + 1 > 1_000) {
    return { ok: false, message: `SANDBOX_PREVIEW_PORTS is at most 1000 ports wide: ${text}.` };
  }
  return { ok: true, range: { min, max } };
}

/** The whole pool, lowest first. */
export function previewPortPool(range: PreviewPortRange = DEFAULT_PREVIEW_PORT_RANGE): number[] {
  const pool: number[] = [];
  for (let port = range.min; port <= range.max; port += 1) pool.push(port);
  return pool;
}

// ─── What the process is told ───────────────────────────────────────────────

/** `<PREFIX>_<NAME>` — a name upper-cased, hyphens to underscores. */
export function envName(prefix: string, name: string): string {
  return `${prefix}_${name.toUpperCase().replace(/-/g, '_')}`;
}

/**
 * The variables a preview's command starts with, over the project's own:
 * `PORT` (the first port — the convention nearly every framework reads)
 * and `PORT_<NAME>` for every port it declared, an interface the proxy
 * can reach (`HOST`), and where each port is served
 * (`RENKEI_PREVIEW_URL` for the first, `RENKEI_PREVIEW_URL_<NAME>` for
 * each), for a framework that needs its base path or origin. `RENKEI_*`
 * names are the sandbox's own and cannot be set from a `.env`.
 */
export function previewEnvironment(
  ports: ReadonlyArray<{ name: string; port: number; url: string }>
): Record<string, string> {
  const [primary] = ports;
  if (!primary) return {};
  const env: Record<string, string> = {
    PORT: String(primary.port),
    HOST: '0.0.0.0',
    HOSTNAME: '0.0.0.0',
    RENKEI_PREVIEW_PORT: String(primary.port),
    RENKEI_PREVIEW_URL: primary.url,
  };
  for (const binding of ports) {
    env[envName('PORT', binding.name)] = String(binding.port);
    env[envName('RENKEI_PREVIEW_URL', binding.name)] = binding.url;
  }
  return env;
}

/** `PREVIEW_<NAME>` — a preview's name as a variable prefix. */
export function previewEnvPrefix(name: string): string {
  return envName('PREVIEW', name);
}

/**
 * What every command and every other preview is told about the previews
 * that are up: for each, `PREVIEW_<NAME>_PORT` and `PREVIEW_<NAME>_URL`
 * (its first port's loopback number — for a dev server that proxies
 * `/api` to a backend beside it — and the address a browser reaches it
 * at, the share link when it has one), and the same per named port as
 * `PREVIEW_<NAME>_<PORT>_PORT` / `_URL`. A UI and an API on two previews
 * find each other this way; on one preview they are `PORT_<NAME>`s.
 */
export function previewNeighbourEnvironment(
  previews: ReadonlyArray<{
    name: string;
    ports: ReadonlyArray<{ name: string; port: number; url: string }>;
  }>
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const preview of [...previews].sort((a, b) => a.name.localeCompare(b.name))) {
    const prefix = previewEnvPrefix(preview.name);
    const [primary] = preview.ports;
    if (!primary) continue;
    env[`${prefix}_PORT`] = String(primary.port);
    env[`${prefix}_URL`] = primary.url;
    for (const binding of preview.ports) {
      env[`${envName(prefix, binding.name)}_PORT`] = String(binding.port);
      env[`${envName(prefix, binding.name)}_URL`] = binding.url;
    }
  }
  return env;
}

// ─── Proxy headers ──────────────────────────────────────────────────────────

/**
 * Headers that belong to one connection, not to the message, and so
 * never cross a proxy (RFC 9110 §7.6.1), plus the ones each hop sets for
 * itself (host, content-length is recomputed by the sender).
 */
export const HOP_BY_HOP_HEADERS: ReadonlySet<string> = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

type HeaderValue = string | string[] | undefined;

/** Everything but the hop-by-hop headers (and `host`), lower-cased. */
export function stripHopByHop(
  headers: Record<string, HeaderValue>
): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    const key = name.toLowerCase();
    if (HOP_BY_HOP_HEADERS.has(key) || key === 'host') continue;
    out[key] = value;
  }
  return out;
}

/**
 * What the worker's own callers send it that the preview's server must never
 * see: the bearer key that is this worker's whole boundary, and the subject
 * it trusts beside it. The server on the other side runs a repository's or
 * a model's code.
 */
const WORKER_ONLY_HEADERS = new Set(['authorization', 'proxy-authorization', 'x-sandbox-subject']);

/** The headers a preview's server is sent: no hop-by-hop ones, none of the worker's own. */
export function upstreamRequestHeaders(
  headers: Record<string, HeaderValue>
): Record<string, string | string[]> {
  const out = stripHopByHop(headers);
  for (const name of WORKER_ONLY_HEADERS) delete out[name];
  return out;
}

/**
 * A `cookie` header without the named cookies — the web app's own
 * session cookie must never reach a project's server, which is running
 * the project's own code: a repository that captured it would hold the
 * person's session. Empty when nothing is left.
 */
export function stripCookies(cookieHeader: string, names: readonly string[]): string {
  return cookieHeader
    .split(';')
    .map((pair) => pair.trim())
    .filter((pair) => {
      if (!pair) return false;
      const name = pair.slice(0, pair.indexOf('=') === -1 ? pair.length : pair.indexOf('=')).trim();
      return !names.includes(name);
    })
    .join('; ');
}

/**
 * The response headers the browser gets back: hop-by-hop ones dropped,
 * and a `location` that names a path on the server (`/login`) rewritten
 * to the same path under the proxy's own prefix, so a redirect lands
 * back inside the preview rather than on the web app's own routes. An
 * absolute location is left alone — a server that redirects to a full
 * URL knows where it is (RENKEI_PREVIEW_URL), or means to leave.
 */
export function proxyResponseHeaders(
  headers: Record<string, HeaderValue>,
  prefix: string
): Record<string, string | string[]> {
  const out = stripHopByHop(headers);
  const location = out.location;
  if (typeof location === 'string' && location.startsWith('/') && !location.startsWith('//')) {
    out.location = `${prefix.replace(/\/$/, '')}${location}`;
  }
  return out;
}

/**
 * How a preview's port is addressed through the web app: the first port
 * at `…/previews/<name>/app/`, any port by name at
 * `…/previews/<name>/ports/<port>/`; a public port at its own token.
 */
export function previewProxyPath(input: {
  projectId: string;
  chatId?: string | null;
  name: string;
  /** A named port; absent means the first port's `app/` address. */
  port?: string | null;
}): string {
  const chat = input.chatId ? `/chats/${input.chatId}` : '';
  const tail = input.port ? `ports/${input.port}` : 'app';
  return `/api/code/projects/${input.projectId}${chat}/previews/${input.name}/${tail}/`;
}

export function publicPreviewPath(token: string): string {
  return `/api/code/preview/${token}/`;
}
