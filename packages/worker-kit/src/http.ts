import { timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

/**
 * The bearer-authenticated JSON-over-HTTP shape every egress worker speaks
 * to the web app: a health check, a bearer check, one POST op per pathname
 * segment, a size-capped JSON body, and a top-level catch that never lets
 * an unhandled rejection hang a response. This file (plus a connector's own
 * `WorkerErrorType`/`statusForError`/`sendError`, kept local since the
 * error vocabulary differs per connector) was identical, function for
 * function, across worker-mirth, worker-onbase, worker-admanager and
 * worker-fileshares — extracted once they'd proven it by staying that way
 * through four independent connectors.
 */

export function sendJson(response: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload),
  });
  response.end(payload);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/**
 * A bearer key with the name of the caller it was issued to. A worker that
 * tells its callers apart (the delegate: web, worker, agents) hands these
 * in; one that does not keeps passing plain strings, which carry the name
 * `default`.
 */
export interface NamedApiKey {
  name: string;
  key: string;
}

export const DEFAULT_CALLER = 'default';

function namedKeyOf(entry: string | NamedApiKey): NamedApiKey {
  return typeof entry === 'string' ? { name: DEFAULT_CALLER, key: entry } : entry;
}

/**
 * Which configured key the request presented, by constant-time comparison
 * against every one of them, or null. The name tells a worker who is
 * calling; the key itself never travels further than this check.
 */
export function matchApiKey(
  request: IncomingMessage,
  keys: readonly (string | NamedApiKey)[]
): NamedApiKey | null {
  if (keys.length === 0) return null;
  const match = request.headers.authorization?.match(/^Bearer\s+(.+)$/i);
  if (!match) return null;
  const presented = Buffer.from(match[1].trim());
  let matched: NamedApiKey | null = null;
  for (const entry of keys) {
    const named = namedKeyOf(entry);
    const configured = Buffer.from(named.key);
    // Length is not secret (it leaks via the comparison anyway); the contents are.
    if (presented.length === configured.length && timingSafeEqual(presented, configured)) {
      matched ??= named;
    }
  }
  return matched;
}

export function authorized(
  request: IncomingMessage,
  keys: readonly (string | NamedApiKey)[]
): boolean {
  return matchApiKey(request, keys) !== null;
}

/**
 * The bearer keys a worker's environment names, with their callers:
 * `${prefix}_API_KEYS` as `name=key,name=key` (one key per calling
 * process), and `${prefix}_API_KEY` as comma-separated keys that all carry
 * `defaultName` — the one-shared-key form every worker started with, kept
 * so an existing deployment keeps working. A name may appear more than
 * once (rotation overlap). Malformed entries are dropped, never widened.
 */
export function parseNamedApiKeys(
  env: NodeJS.ProcessEnv,
  prefix: string,
  defaultName = DEFAULT_CALLER
): NamedApiKey[] {
  const out: NamedApiKey[] = [];
  for (const entry of (env[`${prefix}_API_KEYS`] ?? '').split(',')) {
    const equals = entry.indexOf('=');
    if (equals <= 0) continue;
    const name = entry.slice(0, equals).trim();
    const key = entry.slice(equals + 1).trim();
    if (/^[a-z][a-z0-9_-]{0,31}$/.test(name) && key) out.push({ name, key });
  }
  for (const key of (env[`${prefix}_API_KEY`] ?? '').split(',')) {
    if (key.trim()) out.push({ name: defaultName, key: key.trim() });
  }
  return out;
}

/** Read a request body up to `cap` bytes; null means the cap was exceeded. */
export function readBody(request: IncomingMessage, cap: number): Promise<Buffer | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let received = 0;
    request.on('data', (chunk: Buffer) => {
      received += chunk.byteLength;
      if (received > cap) {
        request.removeAllListeners('data');
        request.removeAllListeners('end');
        resolve(null);
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => resolve(Buffer.concat(chunks)));
    request.on('error', reject);
  });
}

/** The generic error tags every worker answers with; a connector's own
 *  `WorkerErrorType` is a superset that adds its domain-specific ones
 *  (`bad_credentials`, `no_instance`, `session_expired`, …). */
export type GenericWorkerError =
  | 'bad_request'
  | 'unauthorized'
  /** The key is good, but the caller it names may not run this op. */
  | 'forbidden'
  | 'too_large'
  | 'unknown_operation'
  | 'method_not_allowed'
  | 'internal';

/** Who is calling, as the matched bearer key says. */
export interface CallContext {
  caller: string;
}

export type RawHandler = (
  request: IncomingMessage,
  response: ServerResponse,
  context: CallContext
) => Promise<void>;

export type JsonRpcHandler = (
  body: Record<string, unknown>,
  response: ServerResponse,
  context: CallContext
) => Promise<void>;

export interface CreateJsonRpcServerOptions {
  apiKeys: readonly (string | NamedApiKey)[];
  /**
   * Whether the caller the matched key names may run this op; checked after
   * the bearer check and before anything is read or dispatched (the raw
   * handlers and the fallback included). Absent, every key runs every op.
   */
  allowOp?: (caller: string, op: string) => boolean;
  /** Told of every refusal `allowOp` made, for the worker's own access record. */
  onForbidden?: (caller: string, op: string) => void;
  /** Per-connector: Mirth's bulk channel import needs far more room than a
   *  typical op, so this stays a parameter rather than a shared constant. */
  maxBodyBytes: number;
  /** Keyed by the `/v1/<op>` pathname segment. */
  handlers: Record<string, JsonRpcHandler>;
  /**
   * Ops whose body is not JSON — a streamed upload, a proxied request —
   * keyed the same way, dispatched after the bearer check and before any
   * body is read. The handler owns the request and the response.
   */
  rawHandlers?: Record<string, RawHandler>;
  /**
   * Called for an op neither map names, before `unknown_operation` — for a
   * family of ops under one prefix (the delegate's `forward/<connector>/…`).
   * The handler owns the request from here; it answers `unknown_operation`
   * itself when the op is not one of its own.
   */
  fallback?: (
    op: string,
    request: IncomingMessage,
    response: ServerResponse,
    context: CallContext
  ) => Promise<void>;
  /**
   * Paths served BEFORE the bearer check, any method: for a route that
   * carries its own credential in the path (the delegate's git proxy, whose
   * tickets are single-grant and short-lived). The handler owns the whole
   * request; nothing else on the server is reachable this way.
   */
  openPrefixes?: readonly { prefix: string; handler: RawHandler }[];
  /** The connector's own sendError — typed to its own (wider) WorkerErrorType,
   *  which is always assignable here since it can handle every generic tag
   *  this function ever passes plus its own domain-specific ones. */
  sendError: (response: ServerResponse, type: GenericWorkerError, message?: string) => void;
  /** Called (for logging) when a handler throws or rejects; the response is
   *  still answered — 'internal' if nothing was sent yet, otherwise just
   *  ended — regardless of what this does. */
  onUnhandledError: (error: unknown) => void;
}

/**
 * The worker's whole HTTP surface: `GET /health`, then a bearer-checked
 * `POST /v1/<op>` dispatch to `handlers`, with a capped, JSON-parsed body.
 * `handlers` is the only connector-specific input — everything else here
 * is the shape every one of these processes shares.
 */
export function createJsonRpcServer(options: CreateJsonRpcServerOptions): Server {
  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? '/', 'http://worker.internal');

    if (request.method === 'GET' && url.pathname === '/health') {
      return sendJson(response, 200, { ok: true });
    }
    const open = options.openPrefixes?.find((entry) => url.pathname.startsWith(entry.prefix));
    if (open) return open.handler(request, response, { caller: 'open' });
    const matched = matchApiKey(request, options.apiKeys);
    if (!matched) {
      return options.sendError(response, 'unauthorized');
    }
    const context: CallContext = { caller: matched.name };
    if (request.method !== 'POST') {
      return options.sendError(response, 'method_not_allowed');
    }

    const op = url.pathname.startsWith('/v1/') ? url.pathname.slice('/v1/'.length) : '';
    if (options.allowOp && !options.allowOp(context.caller, op)) {
      options.onForbidden?.(context.caller, op);
      return options.sendError(response, 'forbidden', `${context.caller} may not call ${op}`);
    }
    const rawHandler = options.rawHandlers?.[op];
    if (rawHandler) return rawHandler(request, response, context);
    const handler = options.handlers[op];
    if (!handler) {
      if (options.fallback) return options.fallback(op, request, response, context);
      return options.sendError(response, 'unknown_operation');
    }
    const raw = await readBody(request, options.maxBodyBytes);
    if (raw === null) {
      return options.sendError(response, 'too_large');
    }
    let body: unknown;
    try {
      body = JSON.parse(raw.toString('utf8') || '{}');
    } catch {
      return options.sendError(response, 'bad_request');
    }
    if (!isRecord(body)) {
      return options.sendError(response, 'bad_request');
    }
    await handler(body, response, context);
  }

  return createServer((request, response) => {
    void handle(request, response).catch((error: unknown) => {
      options.onUnhandledError(error);
      if (!response.headersSent) {
        options.sendError(response, 'internal');
      } else {
        response.end();
      }
    });
  });
}
