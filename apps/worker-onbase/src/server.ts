/**
 * The OnBase worker's HTTP surface — the only process that dials a
 * customer's OnBase API Server or Hyland IdP. Both usually live on a
 * private network, which the web app's SSRF guard (safe-fetch) rightly
 * refuses to touch; the guard stays intact because the dialing happens
 * here, behind an authenticated seam, against URLs resolved from the
 * tenant's STORED configuration — a caller can name a tenant, never a
 * host. (`test-connection` deliberately accepts unsaved URLs so the admin
 * form can test before saving; they pass the same parser.)
 *
 * Plain node:http like worker-fileshares: a handful of POST ops and a
 * health check. The bearer key marks the caller as the web app, which has
 * already authenticated its user; per-user authority is the OnBase access
 * token that rides each request — this worker holds no tokens of its own
 * and stores nothing.
 *
 * Ops:
 *   discover        — OIDC discovery for the tenant's IdP (or an explicit
 *                     issuer, for test-connection), cached ~10 minutes.
 *   token           — authorization-code (PKCE) exchange or refresh.
 *   revoke          — best-effort token revocation on disconnect.
 *   api             — one Document API request; JSON envelope back.
 *   content         — rendition bytes, streamed within the org's cap.
 *   put-bytes       — one file part into an OnBase upload staging slot.
 *   test-connection — reachability of IdP and API server, saved or unsaved.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { getOrgSettings } from '@renkei/settings';
import {
  oidcDiscoveryUrl,
  parseDiscoveryDocument,
  type OnBaseIdpEndpoints,
} from '@renkei/connector-onbase';
import { parseHttpUrl, resolveOnBaseConfig, type ConfigError, type OnBaseTenantConfig } from './config';
import { logger } from './logger';
import type { Result } from '@campfhir/safe-functions/types';

export interface OnBaseServerDeps {
  /** The parsed TOKEN_ENCRYPTION_KEY; opens the tenant's connector secrets. */
  encryptionKey: Buffer;
  /** Accepted bearer keys; empty means every request is refused. */
  apiKeys: string[];
  /** Injected in tests; production uses orgTransferLimit. */
  maxTransferBytes?: (tenantId: string) => Promise<number>;
  /** Injected in tests; production reads connector_configs. */
  resolveConfig?: (tenantId: string) => Promise<Result<OnBaseTenantConfig, ConfigError>>;
  /** Injected clock for discovery-cache tests. */
  now?: () => number;
}

const DEFAULT_TRANSFER_BYTES = 20_971_520;
/** Operation requests are small JSON; anything bigger is not one of ours. */
const MAX_JSON_BYTES = 1_048_576;
const DISCOVERY_TTL_MS = 10 * 60 * 1000;
const IDP_TIMEOUT_MS = 15_000;
const API_TIMEOUT_MS = 30_000;
const CONTENT_TIMEOUT_MS = 60_000;

export async function orgTransferLimit(tenantId: string): Promise<number> {
  const settings = await getOrgSettings(tenantId);
  return settings.ok ? settings.val.maxAttachmentBytes : DEFAULT_TRANSFER_BYTES;
}

type WorkerErrorType =
  | 'bad_request'
  | 'unauthorized'
  | 'not_configured'
  | 'store'
  | 'discovery_failed'
  | 'unreachable'
  | 'token_failed'
  | 'invalid_grant'
  | 'api_error'
  | 'too_large'
  | 'unknown_operation'
  | 'method_not_allowed'
  | 'internal';

function statusForError(type: WorkerErrorType): number {
  switch (type) {
    case 'bad_request':
    case 'invalid_grant':
      return 400;
    case 'unauthorized':
      return 401;
    case 'too_large':
      return 413;
    case 'not_configured':
      return 503;
    case 'store':
    case 'internal':
      return 500;
    case 'unknown_operation':
      return 404;
    case 'method_not_allowed':
      return 405;
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

/**
 * The one path filter between a caller and the Document API. Paths are
 * OnBase API routes, not file paths, but the same discipline applies:
 * absolute within the API base, never climbing, never a second URL.
 */
function validApiPath(path: string): boolean {
  if (!path.startsWith('/')) return false;
  if (path.includes('..') || path.includes('://') || path.startsWith('//')) return false;
  return true;
}

async function timedFetch(
  url: string,
  init: RequestInit,
  timeoutMs: number
): Promise<Response | { failed: string }> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    const timedOut = error instanceof Error && error.name === 'TimeoutError';
    return { failed: timedOut ? `timed out after ${timeoutMs}ms` : 'could not be reached' };
  }
}

interface DiscoveryCacheEntry {
  endpoints: OnBaseIdpEndpoints;
  expiresAt: number;
}

export function createOnBaseServer(deps: OnBaseServerDeps): Server {
  const transferLimit = deps.maxTransferBytes ?? orgTransferLimit;
  const resolveConfig =
    deps.resolveConfig ?? ((tenantId: string) => resolveOnBaseConfig(tenantId, deps.encryptionKey));
  const now = deps.now ?? Date.now;
  // Only successes are cached: an error remembered as endpoints would not
  // heal on its own.
  const discoveryCache = new Map<string, DiscoveryCacheEntry>();

  async function discoverIssuer(
    issuer: string
  ): Promise<OnBaseIdpEndpoints | { error: WorkerErrorType; message: string }> {
    const cached = discoveryCache.get(issuer);
    if (cached && cached.expiresAt > now()) return cached.endpoints;

    const discoveryUrl = oidcDiscoveryUrl(issuer);
    if (!discoveryUrl.ok) {
      return { error: 'discovery_failed', message: 'The IdP issuer is not a usable URL.' };
    }
    const response = await timedFetch(
      discoveryUrl.val,
      { headers: { accept: 'application/json' } },
      IDP_TIMEOUT_MS
    );
    if ('failed' in response) {
      return { error: 'unreachable', message: `The IdP ${response.failed}.` };
    }
    if (!response.ok) {
      return {
        error: 'discovery_failed',
        message: `OIDC discovery answered ${response.status}.`,
      };
    }
    const document: unknown = await response.json().catch(() => null);
    const endpoints = parseDiscoveryDocument(document);
    if (!endpoints.ok) {
      return {
        error: 'discovery_failed',
        message: 'The discovery document is missing the authorization or token endpoint.',
      };
    }
    discoveryCache.set(issuer, { endpoints: endpoints.val, expiresAt: now() + DISCOVERY_TTL_MS });
    return endpoints.val;
  }

  async function configFor(
    body: Record<string, unknown>,
    response: ServerResponse
  ): Promise<OnBaseTenantConfig | null> {
    const tenantId = str(body.tenantId);
    if (!tenantId) {
      sendError(response, 'bad_request', 'tenantId is required');
      return null;
    }
    const config = await resolveConfig(tenantId);
    if (!config.ok) {
      sendError(
        response,
        config.err.type,
        config.err.type === 'not_configured'
          ? 'OnBase is not configured for this organization.'
          : undefined
      );
      return null;
    }
    return config.val;
  }

  /** The client-auth form fields; Hyland IdP accepts client_secret_post. */
  function clientAuth(config: OnBaseTenantConfig): Record<string, string> {
    return {
      client_id: config.clientId,
      ...(config.clientSecret ? { client_secret: config.clientSecret } : {}),
    };
  }

  type Handler = (body: Record<string, unknown>, response: ServerResponse) => Promise<void>;

  const handlers: Record<string, Handler> = {
    async discover(body, response) {
      // An explicit issuer serves test-connection's unsaved form; anything
      // else resolves the stored tenant configuration.
      const explicit = str(body.issuer);
      let issuer: string;
      if (explicit) {
        const parsed = parseHttpUrl(explicit, body.allowInsecureHttp === true);
        if (!parsed) return sendError(response, 'bad_request', 'issuer is not a usable URL');
        issuer = parsed;
      } else {
        const config = await configFor(body, response);
        if (!config) return;
        issuer = config.idpIssuer;
      }
      const endpoints = await discoverIssuer(issuer);
      if ('error' in endpoints) return sendError(response, endpoints.error, endpoints.message);
      sendJson(response, 200, endpoints);
    },

    async token(body, response) {
      const config = await configFor(body, response);
      if (!config) return;
      const grant = body.grant;
      if (!isRecord(grant)) return sendError(response, 'bad_request', 'grant is required');

      let form: URLSearchParams;
      if (grant.type === 'authorization_code') {
        const code = str(grant.code);
        const redirectUri = str(grant.redirectUri);
        const codeVerifier = str(grant.codeVerifier);
        if (!code || !redirectUri || !codeVerifier) {
          return sendError(response, 'bad_request', 'code, redirectUri and codeVerifier are required');
        }
        form = new URLSearchParams({
          grant_type: 'authorization_code',
          code,
          redirect_uri: redirectUri,
          code_verifier: codeVerifier,
          ...clientAuth(config),
        });
      } else if (grant.type === 'refresh_token') {
        const refreshToken = str(grant.refreshToken);
        if (!refreshToken) return sendError(response, 'bad_request', 'refreshToken is required');
        form = new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: refreshToken,
          ...clientAuth(config),
        });
      } else {
        return sendError(response, 'bad_request', 'grant.type must be authorization_code or refresh_token');
      }

      const endpoints = await discoverIssuer(config.idpIssuer);
      if ('error' in endpoints) return sendError(response, endpoints.error, endpoints.message);

      const tokenResponse = await timedFetch(
        endpoints.tokenEndpoint,
        {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
          body: form,
        },
        IDP_TIMEOUT_MS
      );
      if ('failed' in tokenResponse) {
        return sendError(response, 'unreachable', `The IdP token endpoint ${tokenResponse.failed}.`);
      }
      const payload: unknown = await tokenResponse.json().catch(() => null);
      if (!tokenResponse.ok) {
        // Only an EXPLICIT invalid_grant means the code/refresh token is
        // dead — the signal on which the caller may delete a grant.
        // Anything else stays token_failed (the Zoom-adapter discipline).
        const errorTag = isRecord(payload) ? str(payload.error) : '';
        if (errorTag === 'invalid_grant') {
          return sendError(response, 'invalid_grant', 'The IdP reports the grant is no longer valid.');
        }
        logger.warn('token exchange failed with {status}', {
          component: 'worker-onbase/token',
          status: tokenResponse.status,
          idpError: errorTag || '(none)',
        });
        return sendError(response, 'token_failed', `The IdP answered ${tokenResponse.status}.`);
      }
      if (!isRecord(payload) || typeof payload.access_token !== 'string') {
        return sendError(response, 'token_failed', 'The IdP token response is malformed.');
      }
      // Verbatim: the web side owns interpretation (id_token claims, expiry).
      sendJson(response, 200, payload);
    },

    async revoke(body, response) {
      const config = await configFor(body, response);
      if (!config) return;
      const token = str(body.token);
      if (!token) return sendError(response, 'bad_request', 'token is required');

      const endpoints = await discoverIssuer(config.idpIssuer);
      if ('error' in endpoints) return sendError(response, endpoints.error, endpoints.message);
      if (!endpoints.revocationEndpoint) return sendJson(response, 200, { revoked: false });

      const revokeResponse = await timedFetch(
        endpoints.revocationEndpoint,
        {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            token,
            ...(str(body.tokenTypeHint) ? { token_type_hint: str(body.tokenTypeHint) } : {}),
            ...clientAuth(config),
          }),
        },
        IDP_TIMEOUT_MS
      );
      // Best-effort by contract: disconnect proceeds either way, so failure
      // is reported, never thrown.
      sendJson(response, 200, { revoked: !('failed' in revokeResponse) && revokeResponse.ok });
    },

    async api(body, response) {
      const config = await configFor(body, response);
      if (!config) return;
      const accessToken = str(body.accessToken);
      const method = str(body.method).toUpperCase();
      const path = str(body.path);
      if (!accessToken) return sendError(response, 'bad_request', 'accessToken is required');
      if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
        return sendError(response, 'bad_request', 'method is not one of GET/POST/PUT/PATCH/DELETE');
      }
      if (!validApiPath(path)) return sendError(response, 'bad_request', 'path is not a usable API path');

      const url = new URL(config.apiBaseUrl + path);
      if (isRecord(body.query)) {
        for (const [key, value] of Object.entries(body.query)) {
          if (typeof value === 'string') url.searchParams.append(key, value);
          else if (Array.isArray(value)) {
            for (const item of value) if (typeof item === 'string') url.searchParams.append(key, item);
          }
        }
      }

      const upstream = await timedFetch(
        url.toString(),
        {
          method,
          headers: {
            authorization: `Bearer ${accessToken}`,
            accept: str(body.accept) || 'application/json',
            ...(body.body !== undefined ? { 'content-type': 'application/json' } : {}),
          },
          ...(body.body !== undefined ? { body: JSON.stringify(body.body) } : {}),
        },
        API_TIMEOUT_MS
      );
      if ('failed' in upstream) {
        return sendError(response, 'unreachable', `The OnBase API server ${upstream.failed}.`);
      }
      // An envelope, not passthrough: the web side needs the upstream status
      // (401 drives its refresh-and-retry) without confusing it with this
      // worker's own statuses.
      const text = await upstream.text();
      sendJson(response, 200, {
        status: upstream.status,
        contentType: upstream.headers.get('content-type'),
        body: text,
      });
    },

    async content(body, response) {
      const config = await configFor(body, response);
      if (!config) return;
      const accessToken = str(body.accessToken);
      const path = str(body.path);
      if (!accessToken) return sendError(response, 'bad_request', 'accessToken is required');
      if (!validApiPath(path)) return sendError(response, 'bad_request', 'path is not a usable API path');

      const upstream = await timedFetch(
        config.apiBaseUrl + path,
        {
          headers: {
            authorization: `Bearer ${accessToken}`,
            ...(str(body.accept) ? { accept: str(body.accept) } : {}),
          },
        },
        CONTENT_TIMEOUT_MS
      );
      if ('failed' in upstream) {
        return sendError(response, 'unreachable', `The OnBase API server ${upstream.failed}.`);
      }
      if (!upstream.ok) {
        const detail = await upstream.text().catch(() => '');
        // The upstream status is forwarded (a JSON body marks it as an
        // error); 401 in particular must reach the web side's refresh logic.
        return sendJson(response, upstream.status, {
          error: { type: 'api_error', status: upstream.status, message: detail.slice(0, 500) },
        });
      }
      const limit = await transferLimit(str(body.tenantId));
      const bytes = Buffer.from(await upstream.arrayBuffer());
      if (bytes.byteLength > limit) {
        return sendError(response, 'too_large', `The content exceeds the ${limit}-byte limit.`);
      }
      const headers: Record<string, string> = {
        'content-type': upstream.headers.get('content-type') ?? 'application/octet-stream',
        'content-length': String(bytes.byteLength),
      };
      const disposition = upstream.headers.get('content-disposition');
      if (disposition) headers['content-disposition'] = disposition;
      response.writeHead(200, headers);
      response.end(bytes);
    },

    async 'test-connection'(body, response) {
      const tenantId = str(body.tenantId);
      if (!tenantId) return sendError(response, 'bad_request', 'tenantId is required');
      const stored = await resolveConfig(tenantId);
      const unsaved = isRecord(body.unsaved) ? body.unsaved : {};
      const allowInsecureHttp =
        unsaved.allowInsecureHttp === true ||
        (unsaved.allowInsecureHttp === undefined && stored.ok && stored.val.allowInsecureHttp);
      // The unsaved form payload wins over the stored row: the admin is
      // testing what they are ABOUT to save (the fileshares discipline).
      const idpIssuer =
        parseHttpUrl(unsaved.idpIssuer, allowInsecureHttp) ??
        (stored.ok ? stored.val.idpIssuer : null);
      const apiBaseUrl =
        parseHttpUrl(unsaved.apiBaseUrl, allowInsecureHttp) ??
        (stored.ok ? stored.val.apiBaseUrl : null);
      if (!idpIssuer || !apiBaseUrl) {
        return sendError(
          response,
          'bad_request',
          'Both the API server URL and the IdP issuer are needed (https, unless insecure HTTP is allowed).'
        );
      }

      const endpoints = await discoverIssuer(idpIssuer);
      const idp =
        'error' in endpoints
          ? { ok: false as const, error: endpoints.message }
          : { ok: true as const, tokenEndpoint: endpoints.tokenEndpoint };

      // Unauthenticated on purpose; a 401 IS the healthy answer — it proves
      // an OnBase API server is listening and demanding auth.
      const ping = await timedFetch(
        `${apiBaseUrl}/document-types`,
        { headers: { accept: 'application/json' } },
        IDP_TIMEOUT_MS
      );
      const api =
        'failed' in ping
          ? { ok: false as const, error: `The OnBase API server ${ping.failed}.` }
          : ping.status === 401 || ping.ok
            ? { ok: true as const, status: ping.status }
            : { ok: false as const, error: `The OnBase API server answered ${ping.status}.` };

      // A failed test is a successful request.
      sendJson(response, 200, { idp, api });
    },
  };

  async function handlePutBytes(
    request: IncomingMessage,
    response: ServerResponse,
    url: URL
  ): Promise<void> {
    const tenantId = url.searchParams.get('tenantId') ?? '';
    const uploadId = url.searchParams.get('uploadId') ?? '';
    const filePart = url.searchParams.get('filePart') ?? '1';
    // The token rides a header, never the query string — query strings end
    // up in access logs.
    const accessToken = str(request.headers['x-onbase-token']);
    if (!tenantId || !uploadId || !accessToken) {
      return sendError(response, 'bad_request', 'tenantId, uploadId and x-onbase-token are required');
    }
    if (!/^\d+$/.test(filePart)) return sendError(response, 'bad_request', 'filePart must be a number');
    const config = await resolveConfig(tenantId);
    if (!config.ok) return sendError(response, config.err.type);

    const limit = await transferLimit(tenantId);
    const bytes = await readBody(request, limit);
    if (bytes === null) {
      return sendError(response, 'too_large', `The file part exceeds the ${limit}-byte limit.`);
    }
    if (bytes.byteLength === 0) return sendError(response, 'bad_request', 'The file part is empty.');

    const upstream = await timedFetch(
      `${config.val.apiBaseUrl}/documents/uploads/${encodeURIComponent(uploadId)}?filePart=${filePart}`,
      {
        method: 'PUT',
        headers: {
          authorization: `Bearer ${accessToken}`,
          'content-type': 'application/octet-stream',
        },
        body: new Uint8Array(bytes),
      },
      CONTENT_TIMEOUT_MS
    );
    if ('failed' in upstream) {
      return sendError(response, 'unreachable', `The OnBase API server ${upstream.failed}.`);
    }
    const text = await upstream.text().catch(() => '');
    sendJson(response, 200, {
      status: upstream.status,
      contentType: upstream.headers.get('content-type'),
      body: text,
    });
  }

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? '/', 'http://onbase.internal');

    if (request.method === 'GET' && url.pathname === '/health') {
      return sendJson(response, 200, { ok: true });
    }
    if (!authorized(request, deps.apiKeys)) {
      return sendError(response, 'unauthorized');
    }
    if (request.method !== 'POST') {
      return sendError(response, 'method_not_allowed');
    }

    if (url.pathname === '/v1/put-bytes') {
      return handlePutBytes(request, response, url);
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
      logger.error('unhandled onbase op failure: {error}', {
        component: 'worker-onbase/server',
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
