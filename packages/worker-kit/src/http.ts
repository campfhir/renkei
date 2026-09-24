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

export function authorized(request: IncomingMessage, keys: string[]): boolean {
  if (keys.length === 0) return false;
  const match = request.headers.authorization?.match(/^Bearer\s+(.+)$/i);
  if (!match) return false;
  const presented = match[1].trim();
  return keys.some((key) => {
    const bufA = Buffer.from(presented);
    const bufB = Buffer.from(key);
    // Length is not secret (it leaks via the comparison anyway); the contents are.
    return bufA.length === bufB.length && timingSafeEqual(bufA, bufB);
  });
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
  | 'too_large'
  | 'unknown_operation'
  | 'method_not_allowed'
  | 'internal';

export type JsonRpcHandler = (
  body: Record<string, unknown>,
  response: ServerResponse
) => Promise<void>;

export interface CreateJsonRpcServerOptions {
  apiKeys: string[];
  /** Per-connector: Mirth's bulk channel import needs far more room than a
   *  typical op, so this stays a parameter rather than a shared constant. */
  maxBodyBytes: number;
  /** Keyed by the `/v1/<op>` pathname segment. */
  handlers: Record<string, JsonRpcHandler>;
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
    if (!authorized(request, options.apiKeys)) {
      return options.sendError(response, 'unauthorized');
    }
    if (request.method !== 'POST') {
      return options.sendError(response, 'method_not_allowed');
    }

    const op = url.pathname.startsWith('/v1/') ? url.pathname.slice('/v1/'.length) : '';
    const handler = options.handlers[op];
    if (!handler) {
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
    await handler(body, response);
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
