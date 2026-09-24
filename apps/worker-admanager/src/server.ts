/**
 * The ADManager Plus worker's HTTP surface — the only process that dials
 * an organization's ADManager Plus servers. Those usually live on a
 * private network the web app's SSRF guard rightly refuses; the guard
 * stays intact because the dialing happens here, behind an authenticated
 * seam, against URLs resolved from the STORED instance registry — a
 * caller can name a tenant and an instance, never a host. (`probe`
 * deliberately accepts an unsaved URL so the admin form can test before
 * saving; it passes the same parser.)
 *
 * Unlike the Mirth worker, there is no session to hold: ADManager Plus
 * takes the authtoken directly as the `Authorization` header on every
 * request, so `api` is a straight decrypt-and-forward with no login
 * call, no cookie jar, and no retry-on-401-then-relogin dance. A 401 here
 * means the stored authtoken itself is bad.
 *
 *  - The bearer key is the trust boundary. Callers holding
 *    ADMANAGER_WORKER_API_KEY are the web app, which has already
 *    authenticated its user (`subject`) — every API call runs on that
 *    person's own stored authtoken, which only THIS process decrypts, and
 *    ADManager Plus judges the account (its token scope, the
 *    technician's delegated rights) on every request. No key configured
 *    means no service — fail closed, never open.
 *  - The API call is a proxy, not an interpreter. `api` forwards one
 *    request and envelopes the upstream status and body back verbatim;
 *    what a route means, and whether a person may attempt it, is decided
 *    by the tools (the person's exposure choice) and by ADManager Plus
 *    itself (the token's scope and the technician's rights).
 *
 * Ops:
 *   api             — one ADManager Plus REST request with the caller's
 *                      own stored authtoken.
 *   test-connection — probe a stored instance with an UNSAVED authtoken
 *                      (the connect flow's validation).
 *   probe           — reachability of a stored or unsaved instance URL,
 *                      unauthenticated (the admin form's test).
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import type { Kysely } from 'kysely';
import type { DB } from '@renkei/db';
import {
  isHttpMethod,
  parseAdManagerCredentials,
  parseBaseUrl,
  resolveInstance,
  resolveTarget,
  validApiPath,
  type AdManagerCredentials,
  type InstanceRow,
  type ResolveError,
  type ResolvedTarget,
  type SubjectTarget,
} from '@renkei/connector-admanager';
import type { Result } from '@campfhir/safe-functions/types';
import { logger } from './logger';
import {
  dialUpstream,
  headerOf,
  type TlsPolicy,
  type UpstreamDialer,
  type UpstreamResponse,
} from './upstream';

export interface AdManagerServerDeps {
  db: Kysely<DB>;
  /** The parsed TOKEN_ENCRYPTION_KEY; opens stored credentials. */
  encryptionKey: Buffer;
  /** Accepted bearer keys; empty means every request is refused. */
  apiKeys: string[];
  /** Injected in tests; production dials the real server. */
  dial?: UpstreamDialer;
  /** Injected in tests; production reads the store. */
  resolveTarget?: (target: SubjectTarget) => Promise<Result<ResolvedTarget, ResolveError>>;
  resolveInstance?: (
    tenantId: string,
    instanceId: string
  ) => Promise<Result<InstanceRow, 'no_instance' | 'store'>>;
}

/** Operation requests are JSON; bodies here are small AD attribute bags. */
const MAX_JSON_BYTES = 1_048_576;
/** The most of an ADManager Plus answer the worker will buffer. */
const MAX_UPSTREAM_BYTES = 4 * 1_048_576;
const API_TIMEOUT_MS = 30_000;

/** The lightest read in the API: no domain/filter parameters required. */
const PROBE_PATH = '/api/v1/domain/listDomains';

type WorkerErrorType =
  | 'bad_request'
  | 'unauthorized'
  | 'no_instance'
  | 'not_connected'
  | 'bad_credentials'
  | 'store'
  | 'unreachable'
  | 'timeout'
  | 'too_large'
  | 'unknown_operation'
  | 'method_not_allowed'
  | 'internal';

export function statusForError(type: WorkerErrorType): number {
  switch (type) {
    case 'bad_request':
      return 400;
    case 'unauthorized':
      return 401;
    case 'not_connected':
      return 403;
    case 'no_instance':
    case 'unknown_operation':
      return 404;
    case 'method_not_allowed':
      return 405;
    case 'too_large':
      return 413;
    case 'bad_credentials':
      return 503;
    case 'timeout':
      return 504;
    case 'store':
    case 'internal':
      return 500;
    default:
      return 502;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function authorized(request: IncomingMessage, keys: string[]): boolean {
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
function readBody(request: IncomingMessage, cap: number): Promise<Buffer | null> {
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

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload),
  });
  response.end(payload);
}

function sendError(response: ServerResponse, type: WorkerErrorType, message?: string): void {
  sendJson(response, statusForError(type), { error: { type, message } });
}

function targetOf(body: Record<string, unknown>): SubjectTarget | null {
  const tenantId = str(body.tenantId);
  const instanceId = str(body.instanceId);
  const subject = str(body.subject);
  if (!tenantId || !instanceId || !subject) return null;
  return { tenantId, instanceId, subject };
}

function tlsOf(instance: InstanceRow): TlsPolicy {
  return { verify: instance.summary.tlsVerify, caPem: instance.caPem };
}

/** Append query parameters exactly once, encoded by URLSearchParams. */
function withQuery(url: string, query: unknown): string {
  if (!isRecord(query)) return url;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      params.append(key, String(value));
    } else if (Array.isArray(value)) {
      for (const item of value) {
        if (typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean') {
          params.append(key, String(item));
        }
      }
    }
  }
  const encoded = params.toString();
  return encoded ? `${url}?${encoded}` : url;
}

export function createAdManagerServer(deps: AdManagerServerDeps): Server {
  const dial = deps.dial ?? dialUpstream;
  const resolve =
    deps.resolveTarget ?? ((target) => resolveTarget(deps.db, deps.encryptionKey, target));
  const resolveOne =
    deps.resolveInstance ??
    ((tenantId: string, instanceId: string) => resolveInstance(deps.db, tenantId, instanceId));

  /** One forwarded request, the authtoken set directly as Authorization. */
  function forward(
    instance: InstanceRow,
    authToken: string,
    body: Record<string, unknown>,
    method: string,
    path: string
  ): ReturnType<UpstreamDialer> {
    const hasBody = body.body !== undefined && body.body !== null && method !== 'GET';
    const payload = hasBody
      ? Buffer.from(typeof body.body === 'string' ? body.body : JSON.stringify(body.body))
      : undefined;
    return dial({
      url: withQuery(`${instance.summary.baseUrl}${path}`, body.query),
      method,
      headers: {
        accept: str(body.accept) || 'application/json',
        ...(authToken ? { authorization: authToken } : {}),
        ...(payload
          ? { 'content-type': 'application/json', 'content-length': String(payload.byteLength) }
          : {}),
      },
      body: payload,
      tls: tlsOf(instance),
      timeoutMs: API_TIMEOUT_MS,
      maxBodyBytes: MAX_UPSTREAM_BYTES,
    });
  }

  function envelope(response: ServerResponse, upstream: UpstreamResponse): void {
    // An envelope, not passthrough: the web side needs the upstream status
    // (a 401 is ADManager Plus's verdict on the token, a 404 a missing
    // user) without confusing it with this worker's own.
    sendJson(response, 200, {
      status: upstream.status,
      contentType: headerOf(upstream, 'content-type'),
      body: upstream.body.toString('utf8'),
    });
  }

  type Handler = (body: Record<string, unknown>, response: ServerResponse) => Promise<void>;

  const handlers: Record<string, Handler> = {
    async api(body, response) {
      const target = targetOf(body);
      if (!target)
        return sendError(response, 'bad_request', 'tenantId, instanceId and subject are required');
      const method = str(body.method).toUpperCase();
      const path = str(body.path);
      if (!isHttpMethod(method)) {
        return sendError(response, 'bad_request', 'method is not one of GET/POST/PATCH/DELETE');
      }
      if (!validApiPath(path)) {
        return sendError(response, 'bad_request', 'path is not a usable API path');
      }

      const resolved = await resolve(target);
      if (!resolved.ok) return sendError(response, resolved.err.type);
      const { instance, credentials } = resolved.val;

      const upstream = await forward(instance, credentials.authToken, body, method, path);
      if ('failed' in upstream) {
        const type: WorkerErrorType =
          upstream.failed === 'timeout'
            ? 'timeout'
            : upstream.failed === 'too_large'
              ? 'too_large'
              : 'unreachable';
        return sendError(response, type, `The ADManager Plus server ${upstream.detail}.`);
      }
      envelope(response, upstream);
    },

    async 'test-connection'(body, response) {
      // The connect flow's validation: a person's unsaved authtoken
      // crosses the authenticated seam once, is re-validated here at the
      // trust boundary, and is tried against the STORED instance before
      // the web app seals and saves it.
      const tenantId = str(body.tenantId);
      const instanceId = str(body.instanceId);
      const credentials: AdManagerCredentials | null = parseAdManagerCredentials(
        body.credentials
      );
      if (!tenantId || !instanceId || !credentials) {
        return sendError(
          response,
          'bad_request',
          'tenantId, instanceId and credentials are required'
        );
      }
      const instance = await resolveOne(tenantId, instanceId);
      if (!instance.ok) return sendError(response, instance.err.type);

      const answer = await forward(
        instance.val,
        credentials.authToken,
        { accept: 'application/json' },
        'GET',
        PROBE_PATH
      );
      if ('failed' in answer) {
        return sendError(
          response,
          answer.failed === 'timeout' ? 'timeout' : 'unreachable',
          `The ADManager Plus server ${answer.detail}.`
        );
      }
      if (answer.status === 401 || answer.status === 403) {
        return sendError(
          response,
          'bad_credentials',
          'The ADManager Plus server rejected this authtoken.'
        );
      }
      if (answer.status < 200 || answer.status >= 300) {
        return sendError(
          response,
          'unreachable',
          `The ADManager Plus server answered ${answer.status} to the validation request.`
        );
      }
      sendJson(response, 200, { ok: true });
    },

    async probe(body, response) {
      // The admin form's reachability test. Unauthenticated on purpose: a
      // 401 IS the healthy answer — it proves an ADManager Plus REST API
      // is listening and demanding a token. The unsaved form wins over
      // the stored row, so an operator tests what they are ABOUT to
      // save.
      const tenantId = str(body.tenantId);
      if (!tenantId) return sendError(response, 'bad_request', 'tenantId is required');
      let instance: InstanceRow;
      const unsaved = isRecord(body.unsaved) ? body.unsaved : null;
      if (unsaved) {
        const allowInsecureHttp = unsaved.allowInsecureHttp === true;
        const baseUrl = parseBaseUrl(unsaved.baseUrl, allowInsecureHttp);
        if (!baseUrl) {
          return sendError(
            response,
            'bad_request',
            'baseUrl is not a usable URL (https, unless insecure HTTP is allowed)'
          );
        }
        instance = {
          summary: {
            id: '',
            name: '',
            environment: '',
            baseUrl,
            tlsVerify: unsaved.tlsVerify !== false,
            hasCustomCa: typeof unsaved.caPem === 'string' && unsaved.caPem.trim() !== '',
            allowInsecureHttp,
            enabled: true,
          },
          caPem: typeof unsaved.caPem === 'string' && unsaved.caPem.trim() ? unsaved.caPem : null,
          settings: {},
          createdAt: new Date(0),
          updatedAt: new Date(0),
        };
      } else {
        const instanceId = str(body.instanceId);
        if (!instanceId)
          return sendError(response, 'bad_request', 'instanceId or unsaved is required');
        const stored = await resolveOne(tenantId, instanceId);
        if (!stored.ok) return sendError(response, stored.err.type);
        instance = stored.val;
      }

      const ping = await forward(instance, '', { accept: 'application/json' }, 'GET', PROBE_PATH);
      if ('failed' in ping) {
        // A failed probe is a successful request.
        return sendJson(response, 200, {
          ok: false,
          error: `The ADManager Plus server ${ping.detail}.`,
        });
      }
      const reachable = ping.status === 401 || ping.status === 200;
      sendJson(response, 200, {
        ok: reachable,
        status: ping.status,
        ...(reachable ? {} : { error: `The ADManager Plus server answered ${ping.status}.` }),
      });
    },
  };

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? '/', 'http://admanager.internal');

    if (request.method === 'GET' && url.pathname === '/health') {
      return sendJson(response, 200, { ok: true });
    }
    if (!authorized(request, deps.apiKeys)) {
      return sendError(response, 'unauthorized');
    }
    if (request.method !== 'POST') {
      return sendError(response, 'method_not_allowed');
    }

    const op = url.pathname.startsWith('/v1/') ? url.pathname.slice('/v1/'.length) : '';
    const handler = handlers[op];
    if (!handler) {
      return sendError(response, 'unknown_operation');
    }
    const raw = await readBody(request, MAX_JSON_BYTES);
    if (raw === null) {
      return sendError(response, 'too_large');
    }
    let body: unknown;
    try {
      body = JSON.parse(raw.toString('utf8') || '{}');
    } catch {
      return sendError(response, 'bad_request');
    }
    if (!isRecord(body)) {
      return sendError(response, 'bad_request');
    }
    await handler(body, response);
  }

  return createServer((request, response) => {
    void handle(request, response).catch((error: unknown) => {
      logger.error('unhandled admanager op failure: {error}', {
        component: 'worker-admanager/server',
        error: error instanceof Error ? error.message : String(error),
      });
      if (!response.headersSent) {
        sendError(response, 'internal');
      } else {
        response.end();
      }
    });
  });
}
