/**
 * The Mirth worker's HTTP surface — the only process that dials an
 * organization's Mirth Connect servers. Those usually live on a private
 * network the web app's SSRF guard rightly refuses; the guard stays
 * intact because the dialing happens here, behind an authenticated seam,
 * against URLs resolved from the STORED instance registry — a caller can
 * name a tenant and an instance, never a host. (`probe` deliberately
 * accepts an unsaved URL so the admin form can test before saving; it
 * passes the same parser.)
 *
 * Plain node:http like the fileshare and OnBase workers: a handful of POST
 * ops and a health check. Two rules shape everything here:
 *
 *  - The bearer key is the trust boundary. Callers holding
 *    MIRTH_WORKER_API_KEY are the web app, which has already authenticated
 *    its user (`subject`) — every API call runs on that person's own
 *    stored Mirth credential, which only THIS process decrypts, and the
 *    Mirth server judges the account on every request. No key configured
 *    means no service — fail closed, never open.
 *  - The API call is a proxy, not an interpreter. `api` forwards one
 *    request and envelopes the upstream status and body back verbatim;
 *    what a route means, and whether a person may attempt it, is decided
 *    by the tools (the person's exposure choice) and by Mirth itself (the
 *    account's roles). The worker adds exactly one thing: the login/session
 *    dance, so the web side never touches a password after sealing it.
 *
 * Ops:
 *   api             — one Mirth REST request on the caller's own session.
 *   test-connection — log in with an UNSAVED credential against a stored
 *                     instance (the connect flow's validation).
 *   probe           — reachability of a stored or unsaved instance URL,
 *                     unauthenticated (the admin form's test).
 *   logout          — end the caller's session on disconnect, best effort.
 */

import type { Server, ServerResponse } from 'node:http';
import type { Kysely } from 'kysely';
import type { DB } from '@renkei/db';
import {
  MIRTH_API_PREFIX,
  isHttpMethod,
  parseBaseUrl,
  parseMirthCredentials,
  resolveInstance,
  resolveTarget,
  validApiPath,
  type InstanceRow,
  type MirthCredentials,
  type ResolveError,
  type ResolvedTarget,
  type SubjectTarget,
} from '@renkei/connector-mirth';
import type { Result } from '@campfhir/safe-functions/types';
import { createJsonRpcServer, isRecord, sendJson, str } from '@renkei/worker-kit';
import { logger } from './logger';
import { forgetSession, rememberSession, sessionCookie } from './sessions';
import {
  dialUpstream,
  headerOf,
  setCookiesOf,
  type TlsPolicy,
  type UpstreamDialer,
  type UpstreamResponse,
} from './upstream';

export interface MirthServerDeps {
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

/** Operation requests are JSON; a channel definition can be large but not this large. */
const MAX_JSON_BYTES = 16 * 1_048_576;
/** The most of a Mirth answer the worker will buffer. */
const MAX_UPSTREAM_BYTES = 16 * 1_048_576;
const LOGIN_TIMEOUT_MS = 20_000;
const API_TIMEOUT_MS = 60_000;

/** Mirth's own Swagger UI sends this; harmless everywhere, expected by some proxies. */
const REQUESTED_WITH = 'OpenAPI';

type WorkerErrorType =
  | 'bad_request'
  | 'unauthorized'
  | 'no_instance'
  | 'not_connected'
  | 'bad_credentials'
  | 'login_failed'
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
    case 'login_failed':
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

export function createMirthServer(deps: MirthServerDeps): Server {
  const dial = deps.dial ?? dialUpstream;
  const resolve =
    deps.resolveTarget ?? ((target) => resolveTarget(deps.db, deps.encryptionKey, target));
  const resolveOne =
    deps.resolveInstance ??
    ((tenantId: string, instanceId: string) => resolveInstance(deps.db, tenantId, instanceId));

  /**
   * Log in as the credential's owner and return the session cookies Mirth
   * set. A 401 is Mirth's verdict on the credential (`login_failed`);
   * anything else that is not a 2xx is the server misbehaving.
   */
  async function login(
    instance: InstanceRow,
    credentials: MirthCredentials
  ): Promise<{ cookies: string[] } | { error: WorkerErrorType; message: string }> {
    const form = new URLSearchParams({
      username: credentials.username,
      password: credentials.password,
    }).toString();
    const answer = await dial({
      url: `${instance.summary.baseUrl}${MIRTH_API_PREFIX}/users/_login`,
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        accept: 'application/json',
        'x-requested-with': REQUESTED_WITH,
        'content-length': String(Buffer.byteLength(form)),
      },
      body: Buffer.from(form),
      tls: tlsOf(instance),
      timeoutMs: LOGIN_TIMEOUT_MS,
      maxBodyBytes: 65_536,
    });
    if ('failed' in answer) {
      return {
        error: answer.failed === 'timeout' ? 'timeout' : 'unreachable',
        message: `The Mirth server ${answer.detail}.`,
      };
    }
    if (answer.status === 401 || answer.status === 403) {
      return { error: 'login_failed', message: 'The Mirth server rejected the credentials.' };
    }
    if (answer.status < 200 || answer.status >= 300) {
      return {
        error: 'unreachable',
        message: `The Mirth server answered ${answer.status} to the login.`,
      };
    }
    return { cookies: setCookiesOf(answer) };
  }

  /** One forwarded request on a given cookie header. */
  function forward(
    instance: InstanceRow,
    body: Record<string, unknown>,
    method: string,
    path: string,
    cookie: string | undefined
  ): ReturnType<UpstreamDialer> {
    const hasBody = body.body !== undefined && body.body !== null && method !== 'GET';
    const contentType = str(body.contentType) || 'application/json';
    const payload = hasBody
      ? Buffer.from(typeof body.body === 'string' ? body.body : JSON.stringify(body.body))
      : undefined;
    return dial({
      url: withQuery(`${instance.summary.baseUrl}${MIRTH_API_PREFIX}${path}`, body.query),
      method,
      headers: {
        accept: str(body.accept) || 'application/json',
        'x-requested-with': REQUESTED_WITH,
        ...(cookie ? { cookie } : {}),
        ...(payload
          ? { 'content-type': contentType, 'content-length': String(payload.byteLength) }
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
    // (a 403 is Mirth's authorization verdict on the account, a 404 a
    // missing channel) without confusing it with this worker's own.
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
        return sendError(response, 'bad_request', 'method is not one of GET/POST/PUT/DELETE');
      }
      if (!validApiPath(path)) {
        return sendError(response, 'bad_request', 'path is not a usable API path');
      }

      const resolved = await resolve(target);
      if (!resolved.ok) return sendError(response, resolved.err.type);
      const { instance, credentials } = resolved.val;

      // A held session first; a fresh login only when there is none or the
      // server says the one presented is dead.
      let cookie = sessionCookie(target.tenantId, target.instanceId, target.subject);
      if (!cookie) {
        const session = await login(instance, credentials);
        if ('error' in session) return sendError(response, session.error, session.message);
        rememberSession(target.tenantId, target.instanceId, target.subject, session.cookies);
        cookie = sessionCookie(target.tenantId, target.instanceId, target.subject);
      }

      let upstream = await forward(instance, body, method, path, cookie);
      if (!('failed' in upstream) && upstream.status === 401 && cookie) {
        // The session lapsed between calls: log in once more and retry
        // once. A second 401 is then Mirth's answer, and is forwarded.
        forgetSession(target.tenantId, target.instanceId, target.subject);
        const session = await login(instance, credentials);
        if ('error' in session) return sendError(response, session.error, session.message);
        rememberSession(target.tenantId, target.instanceId, target.subject, session.cookies);
        upstream = await forward(
          instance,
          body,
          method,
          path,
          sessionCookie(target.tenantId, target.instanceId, target.subject)
        );
      }
      if ('failed' in upstream) {
        const type: WorkerErrorType =
          upstream.failed === 'timeout'
            ? 'timeout'
            : upstream.failed === 'too_large'
              ? 'too_large'
              : 'unreachable';
        return sendError(response, type, `The Mirth server ${upstream.detail}.`);
      }
      if (upstream.status === 401)
        forgetSession(target.tenantId, target.instanceId, target.subject);
      else
        rememberSession(target.tenantId, target.instanceId, target.subject, setCookiesOf(upstream));
      envelope(response, upstream);
    },

    async 'test-connection'(body, response) {
      // The connect flow's validation: a person's unsaved credential
      // crosses the authenticated seam once, is re-validated here at the
      // trust boundary, and is tried against the STORED instance before the
      // web app seals and saves it. The session it creates is closed
      // again: nothing is remembered for a credential not yet stored.
      const tenantId = str(body.tenantId);
      const instanceId = str(body.instanceId);
      const credentials = parseMirthCredentials(body.credentials);
      if (!tenantId || !instanceId || !credentials) {
        return sendError(
          response,
          'bad_request',
          'tenantId, instanceId and credentials are required'
        );
      }
      const instance = await resolveOne(tenantId, instanceId);
      if (!instance.ok) return sendError(response, instance.err.type);

      const session = await login(instance.val, credentials);
      if ('error' in session) return sendError(response, session.error, session.message);
      const cookie = session.cookies
        .map((header) => header.split(';', 1)[0])
        .filter(Boolean)
        .join('; ');

      const version = await forward(
        instance.val,
        { accept: 'text/plain' },
        'GET',
        '/server/version',
        cookie || undefined
      );
      // Best effort: the probe session is not kept, so end it server-side.
      void forward(instance.val, {}, 'POST', '/users/_logout', cookie || undefined);
      if ('failed' in version) {
        return sendError(
          response,
          version.failed === 'timeout' ? 'timeout' : 'unreachable',
          `The Mirth server ${version.detail}.`
        );
      }
      sendJson(response, 200, {
        username: credentials.username,
        version: version.status === 200 ? version.body.toString('utf8').trim() : null,
      });
    },

    async probe(body, response) {
      // The admin form's reachability test. Unauthenticated on purpose: a
      // 401 IS the healthy answer — it proves a Mirth REST API is listening
      // and demanding a login. The unsaved form wins over the stored row,
      // so an operator tests what they are ABOUT to save.
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
        { accept: 'text/plain' },
        'GET',
        '/server/version',
        undefined
      );
      if ('failed' in ping) {
        // A failed probe is a successful request.
        return sendJson(response, 200, { ok: false, error: `The Mirth server ${ping.detail}.` });
      }
      const reachable = ping.status === 401 || ping.status === 200;
      sendJson(response, 200, {
        ok: reachable,
        status: ping.status,
        version: ping.status === 200 ? ping.body.toString('utf8').trim() : null,
        ...(reachable ? {} : { error: `The Mirth server answered ${ping.status}.` }),
      });
    },

    async logout(body, response) {
      // Disconnect's courtesy: end the session Mirth holds for this person
      // rather than leave it to idle out. Best-effort by contract.
      const target = targetOf(body);
      if (!target)
        return sendError(response, 'bad_request', 'tenantId, instanceId and subject are required');
      const cookie = sessionCookie(target.tenantId, target.instanceId, target.subject);
      forgetSession(target.tenantId, target.instanceId, target.subject);
      if (!cookie) return sendJson(response, 200, { loggedOut: false });
      const instance = await resolveOne(target.tenantId, target.instanceId);
      if (!instance.ok) return sendJson(response, 200, { loggedOut: false });
      const answer = await forward(instance.val, {}, 'POST', '/users/_logout', cookie);
      sendJson(response, 200, {
        loggedOut: !('failed' in answer) && answer.status >= 200 && answer.status < 300,
      });
    },
  };

  return createJsonRpcServer({
    apiKeys: deps.apiKeys,
    maxBodyBytes: MAX_JSON_BYTES,
    handlers,
    sendError,
    onUnhandledError: (error) => {
      logger.error('unhandled mirth op failure: {error}', {
        component: 'worker-mirth/server',
        error: error instanceof Error ? error.message : String(error),
      });
    },
  });
}
