/**
 * Code project previews — a project's own server (a dev server, an API,
 * a static site) started in its checkout and reached from outside the
 * sandbox through the web app, so a person can open what a chat built
 * in a browser, and a webhook or a phone can reach it. The pure half:
 * bounds, the vocabulary the worker and the web app both speak, what a
 * preview's process is told about where it is, and how the two proxy
 * hops shape headers. Processes, ports and the proxy itself are
 * apps/worker-sandbox's (src/previews.ts); the routes and the tools are
 * apps/web's.
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
/** The ports the worker hands out, when a preview does not insist on one. */
export const PREVIEW_PORT_MIN = 20_000;
export const PREVIEW_PORT_MAX = 29_999;
/** A port a preview may insist on (one the project's own config hard-codes). */
export const PREVIEW_FIXED_PORT_MIN = 1_024;
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

/** One preview as the worker describes it. */
export interface SandboxPreviewSummary {
  id: string;
  name: string;
  /** The checkout (workspace id) the command runs in. */
  workspaceId: string;
  command: string;
  port: number;
  status: PreviewStatus;
  /** The process's exit, once it has one. */
  exitCode: number | null;
  signal: string | null;
  /** The share token, when the preview was started public; null for a session-only one. */
  token: string | null;
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

/** A port the caller insists on, or null to let the worker pick one. */
export function validatePreviewPort(
  input: unknown
): { ok: true; port: number | null } | { ok: false; message: string } {
  if (input === undefined || input === null || input === '') return { ok: true, port: null };
  if (
    typeof input !== 'number' ||
    !Number.isInteger(input) ||
    input < PREVIEW_FIXED_PORT_MIN ||
    input > 65_535
  ) {
    return {
      ok: false,
      message: `A port is a whole number from ${PREVIEW_FIXED_PORT_MIN} to 65535.`,
    };
  }
  return { ok: true, port: input };
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

// ─── What the process is told ───────────────────────────────────────────────

/**
 * The variables a preview's command starts with, over the project's own:
 * the port it must listen on (`PORT`, the convention nearly every
 * framework reads), an interface the proxy can reach (`HOST`), and the
 * public address the preview is served at (`RENKEI_PREVIEW_URL`), for a
 * framework that needs to know its base path or origin. `RENKEI_*` names
 * are the sandbox's own and cannot be set from a `.env`.
 */
export function previewEnvironment(port: number, publicUrl: string): Record<string, string> {
  return {
    PORT: String(port),
    HOST: '0.0.0.0',
    HOSTNAME: '0.0.0.0',
    RENKEI_PREVIEW_PORT: String(port),
    RENKEI_PREVIEW_URL: publicUrl,
  };
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

/** How a preview is addressed through the web app, from the project's routes or the public one. */
export function previewProxyPath(input: {
  projectId: string;
  chatId?: string | null;
  name: string;
}): string {
  const chat = input.chatId ? `/chats/${input.chatId}` : '';
  return `/api/code/projects/${input.projectId}${chat}/previews/${input.name}/app/`;
}

export function publicPreviewPath(token: string): string {
  return `/api/code/preview/${token}/`;
}
