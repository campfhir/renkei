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

import type { Server, ServerResponse } from 'node:http';
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
import { createJsonRpcServer, isRecord, sendJson, str } from '@renkei/worker-kit';
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
  /**
   * The value ADManager Plus's legacy `/RestAPI/*` endpoints want in
   * PRODUCT_NAME, identifying the calling application to the technician
   * account's audit trail. Defaults to 'Renkei'; an operator whose
   * ADManager Plus deployment expects a specific registered name can
   * override it.
   */
  legacyProductName?: string;
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
const API_TIMEOUT_MS = 20_000;

/**
 * No domain/filter parameters required, so it works before anything is
 * chosen or saved. NOT assumed lightweight, though — a large org's answer
 * here has been observed well past MAX_UPSTREAM_BYTES, so every caller of
 * this path passes `readBody: false` to `forward()` and never buffers it;
 * only the status line is ever needed.
 */
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

/**
 * Append query parameters exactly once. Built with URLSearchParams, then
 * `+` is turned into `%20`: URLSearchParams follows
 * application/x-www-form-urlencoded (spaces as `+`), but a confirmed
 * production caller of this same API builds its query strings with `qs`,
 * whose default (RFC 3986) percent-encodes spaces as `%20` instead — and
 * ADManager Plus's own parser is that caller's, not URLSearchParams'.
 * Every `+` remaining after URLSearchParams' own encoding IS an encoded
 * space: a literal `+` in a value is itself escaped to `%2B` first, so
 * this replace can't corrupt one. Left uncorrected, any value with a
 * space — a template name ("AD Update Template"), a filter clause on a
 * display name, a group name ("Finance ReadOnly") — arrives at ADManager
 * Plus with literal `+` characters instead of spaces.
 */
function withQuery(url: string, query: unknown, extra?: Record<string, string>): string {
  const params = new URLSearchParams();
  if (isRecord(query)) {
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
  }
  for (const [key, value] of Object.entries(extra ?? {})) params.append(key, value);
  const encoded = params.toString().replace(/\+/g, '%20');
  return encoded ? `${url}?${encoded}` : url;
}

/**
 * ADManager Plus's legacy query-param-driven API (everything under
 * `/RestAPI/*`) — unlock, password reset, create/modify/disable/enable —
 * predates the `/api/v2/*` JSON API's bearer `Authorization` header. It
 * authenticates via an `AuthToken` + `PRODUCT_NAME` pair sent as BOTH
 * request headers and query parameters (matching a real, confirmed-working
 * caller against a production server), never via `Authorization`.
 */
function isLegacyRestPath(path: string): boolean {
  return path.startsWith('/RestAPI/');
}

export function createAdManagerServer(deps: AdManagerServerDeps): Server {
  const dial = deps.dial ?? dialUpstream;
  const resolve =
    deps.resolveTarget ?? ((target) => resolveTarget(deps.db, deps.encryptionKey, target));
  const resolveOne =
    deps.resolveInstance ??
    ((tenantId: string, instanceId: string) => resolveInstance(deps.db, tenantId, instanceId));

  /**
   * One forwarded request. `/api/v2/*` (and everything else that isn't
   * the legacy API) sends the authtoken as an `Authorization` header, no
   * query-param auth. `/RestAPI/*` — the legacy API unlock, reset-password,
   * create and group-membership actually live on — instead sends
   * `AuthToken`/`PRODUCT_NAME` as both headers and query parameters; see
   * `isLegacyRestPath`.
   *
   * `readBody: false` for a caller that only reads `status` back (probe,
   * test-connection's reachability check) — the response is never
   * buffered or counted against MAX_UPSTREAM_BYTES, so a large answer
   * from an endpoint that was expected to be small can't fail a call
   * that was never going to look past the status line.
   */
  function forward(
    instance: InstanceRow,
    authToken: string,
    body: Record<string, unknown>,
    method: string,
    path: string,
    readBody = true
  ): ReturnType<UpstreamDialer> {
    const hasBody = body.body !== undefined && body.body !== null && method !== 'GET';
    const payload = hasBody
      ? Buffer.from(typeof body.body === 'string' ? body.body : JSON.stringify(body.body))
      : undefined;
    const legacy = isLegacyRestPath(path);
    const productName = deps.legacyProductName?.trim() || 'Renkei';
    const authHeaders: Record<string, string> = {};
    const authQuery: Record<string, string> = {};
    if (authToken) {
      if (legacy) {
        authHeaders.AuthToken = authToken;
        authHeaders.PRODUCT_NAME = productName;
        authQuery.AuthToken = authToken;
        authQuery.PRODUCT_NAME = productName;
      } else {
        authHeaders.authorization = authToken;
      }
    }
    return dial({
      url: withQuery(`${instance.summary.baseUrl}${path}`, body.query, authQuery),
      method,
      headers: {
        accept: str(body.accept) || 'application/json',
        ...authHeaders,
        ...(payload
          ? { 'content-type': 'application/json', 'content-length': String(payload.byteLength) }
          : {}),
      },
      body: payload,
      tls: tlsOf(instance),
      timeoutMs: API_TIMEOUT_MS,
      maxBodyBytes: MAX_UPSTREAM_BYTES,
      readBody,
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
        PROBE_PATH,
        false
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

      const ping = await forward(
        instance,
        '',
        { accept: 'application/json' },
        'GET',
        PROBE_PATH,
        false
      );
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

  return createJsonRpcServer({
    apiKeys: deps.apiKeys,
    maxBodyBytes: MAX_JSON_BYTES,
    handlers,
    sendError,
    onUnhandledError: (error) => {
      logger.error('unhandled admanager op failure: {error}', {
        component: 'worker-admanager/server',
        error: error instanceof Error ? error.message : String(error),
      });
    },
  });
}
