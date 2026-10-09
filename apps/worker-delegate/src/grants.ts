/**
 * Provider tokens, which exist only here (docs/delegate-key-design.md).
 *
 * A caller never asks for a token. It asks for one of:
 *
 *   api            — "send this request to this URL on this person's grant":
 *                    the delegate opens the token, refreshes it when it is
 *                    about to expire (and once more on a 401), checks the URL
 *                    is the provider's own host, attaches the Authorization
 *                    header, and streams the answer back verbatim.
 *   oauth/exchange — trade an authorization code for tokens, which stay here
 *                    behind a short-lived handle; `api` accepts the handle
 *                    for the identity calls a connect flow makes next;
 *   grant/commit   — seal the handle's tokens as the person's grant;
 *   grant/describe — everything about a grant except its tokens;
 *   grant/revoke   — revoke at the provider where one can, then delete;
 *   grant/delete   — delete without revoking.
 */

import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Kysely } from 'kysely';
import type { DB } from '@renkei/db';
import {
  deleteGrant,
  getGrant,
  refreshGrantTokens,
  scopesFromAccessToken,
  setGrant,
  ONBASE,
  ONBASE_ADMIN,
  ZOOM,
  silentLogger,
  type GrantLogger,
  type ProviderGrant,
} from '@renkei/provider-grants';
import { isRecord, readBody, sendJson, str } from '@renkei/worker-kit';
import { onbaseWorkerCall, refreshedOf } from './onbase-worker';
import {
  clientIdOf,
  clientSecretOf,
  grantRow,
  hostAllowed,
  providerConfig,
  providerSpec,
  tokenEndpointFor,
  type ProviderSpec,
} from './providers';

/** Refresh ahead of expiry by this much, as every resolver did before. */
const REFRESH_MARGIN_MS = 2 * 60_000;
/** The most of a caller's request body the proxy will hold (so a 401 can be retried). */
const MAX_REQUEST_BYTES = 64 * 1_048_576;
const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_TIMEOUT_MS = 10 * 60_000;
/** Tokens from an exchange wait this long for their `grant/commit`. */
const PENDING_TTL_MS = 10 * 60_000;

/** Headers that are about the connection, not the answer; never forwarded. */
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'transfer-encoding',
  'te',
  'trailer',
  'upgrade',
  'proxy-authenticate',
  'proxy-authorization',
  // fetch has already decoded the body; the lengths and codings describe the wire, not the bytes.
  'content-encoding',
  'content-length',
  'set-cookie',
]);

/**
 * Request headers a caller may not put on a proxied request: the credential
 * is this process's to supply (`authorization`, `cookie`), the target is the
 * URL's (`host`), the framing is this process's (`content-length` and the
 * hop-by-hop set). A caller that sets one has it dropped, not refused — the
 * clients stage a Request and forward whatever the platform put on it.
 */
const FORBIDDEN_REQUEST_HEADERS = new Set([
  'authorization',
  'cookie',
  'host',
  'content-length',
  'connection',
  'keep-alive',
  'transfer-encoding',
  'te',
  'trailer',
  'upgrade',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
]);

/** How many redirects the proxy follows on a caller's behalf, each one re-checked against the host list. */
export const MAX_REDIRECT_HOPS = 5;

function isRedirect(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

/** What this module reports through; the worker's logger in production, silence in tests. */
export type DelegateLogger = GrantLogger;

export const silentDelegateLogger: DelegateLogger = silentLogger;

export type GrantError =
  | 'bad_request'
  | 'unknown_provider'
  | 'host_not_allowed'
  | 'NO_GRANT'
  | 'GRANT_UNREADABLE'
  /** The owner's key is not delegated to this instance: nothing of theirs opens until they sign in. */
  | 'NEEDS_DELEGATION'
  | 'GRANT_REVOKED'
  | 'REFRESH_FAILED'
  | 'NOT_CONFIGURED'
  | 'EXCHANGE_FAILED'
  | 'NO_PENDING'
  | 'unreachable'
  | 'timeout'
  | 'too_large';

export function statusForGrantError(type: GrantError): number {
  switch (type) {
    case 'bad_request':
      return 400;
    case 'host_not_allowed':
    case 'GRANT_REVOKED':
      return 403;
    case 'unknown_provider':
    case 'NO_GRANT':
    case 'NO_PENDING':
      return 404;
    case 'too_large':
      return 413;
    case 'NEEDS_DELEGATION':
      return 423;
    case 'GRANT_UNREADABLE':
    case 'REFRESH_FAILED':
    case 'EXCHANGE_FAILED':
      return 502;
    case 'NOT_CONFIGURED':
      return 503;
    case 'unreachable':
      return 502;
    case 'timeout':
      return 504;
  }
}

interface Pending {
  provider: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: Date;
  idToken: string | null;
  scope: string | null;
  createdAt: number;
}

/** What a caller may know about a grant: everything but the tokens. */
export function describe(grant: ProviderGrant): Record<string, unknown> {
  return {
    provider: grant.provider,
    accountId: grant.accountId,
    clientId: grant.clientId,
    displayName: grant.displayName,
    expiresAt: grant.expiresAt,
    requestedScopes: grant.requestedScopes,
    grantedScopes: grant.grantedScopes,
    metadata: grant.metadata,
    subject: grant.subject,
  };
}

export class Grants {
  private readonly pending = new Map<string, Pending>();

  constructor(
    private readonly db: Kysely<DB>,
    private readonly encryptionKey: Buffer,
    private readonly logger: DelegateLogger,
    /** Injected in tests; production dials the provider. */
    private readonly fetchImpl: typeof fetch = (input, init) => fetch(input, init)
  ) {}

  /**
   * The grant with a usable access token: read, and refreshed when inside
   * the margin or when `force` says the provider just refused the one we
   * had. Internal — tokens do not leave this module.
   */
  private async access(
    provider: string,
    by: { subject?: string; accountId?: string },
    force = false
  ): Promise<
    { ok: true; grant: ProviderGrant; spec: ProviderSpec } | { ok: false; error: GrantError }
  > {
    const spec = providerSpec(provider);
    if (!spec) return { ok: false, error: 'unknown_provider' };
    const row = await grantRow(this.db, provider, by);
    if (!row) return { ok: false, error: 'NO_GRANT' };
    const read = await getGrant(provider, row.provider_account_id);
    if (!read.ok) {
      // The store names the key verdict in its message; the one a caller
      // can act on is "the owner must sign in", which travels as its own tag.
      const reason = read.err.message ?? '';
      return {
        ok: false,
        error: /NEEDS_DELEGATION|NEEDS_SESSION|NOT_ENROLLED/.test(reason)
          ? 'NEEDS_DELEGATION'
          : 'GRANT_UNREADABLE',
      };
    }
    if (!read.val) return { ok: false, error: 'GRANT_UNREADABLE' };
    let grant = read.val;
    const due = new Date(grant.expiresAt).getTime() - Date.now() < REFRESH_MARGIN_MS;
    if ((due || force) && grant.refreshToken) {
      const config = await providerConfig(spec, this.encryptionKey);
      const adapter = spec.adapter(config, grant);
      if (!adapter) return { ok: false, error: 'NOT_CONFIGURED' };
      const refreshed = await refreshGrantTokens(adapter, grant.accountId, this.logger);
      if (!refreshed.ok) {
        return {
          ok: false,
          error: refreshed.err.type === 'GRANT_REVOKED' ? 'GRANT_REVOKED' : 'REFRESH_FAILED',
        };
      }
      grant = {
        ...grant,
        accessToken: refreshed.val.accessToken,
        refreshToken: refreshed.val.refreshToken,
        expiresAt: refreshed.val.expiresAt.toISOString(),
      };
    }
    return { ok: true, grant, spec };
  }

  /**
   * The access token for a connector worker request the delegate forwards
   * (forward.ts): same resolution as `api`, for a caller inside this
   * process only. Never answered over the wire.
   */
  async accessFor(
    provider: string,
    by: { subject?: string; accountId?: string }
  ): Promise<{ ok: true; token: string } | { ok: false; error: GrantError; status: number }> {
    const access = await this.access(provider, by);
    if (!access.ok)
      return { ok: false, error: access.error, status: statusForGrantError(access.error) };
    return { ok: true, token: access.grant.accessToken };
  }

  // ── api: the proxy ─────────────────────────────────────────────────────

  async api(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const fail = (type: GrantError, message?: string): void => {
      response.setHeader('x-delegate-error', type);
      sendJson(response, statusForGrantError(type), { error: { type, message } });
    };

    const grantHeader = parseJsonHeader(request.headers['x-delegate-grant']);
    const target = str(request.headers['x-delegate-url']);
    const method = str(request.headers['x-delegate-method']).toUpperCase() || 'GET';
    const forwardHeaders = parseJsonHeader(request.headers['x-delegate-headers']) ?? {};
    // Redirects are never left to fetch: every hop is dialed here with the
    // host list re-checked, so the token travels only to the provider's own
    // hosts. A hop elsewhere is handed back to the caller as the 3xx it is.
    const follow = request.headers['x-delegate-redirect'] !== 'manual';
    const timeoutMs = Math.min(
      MAX_TIMEOUT_MS,
      Number(request.headers['x-delegate-timeout-ms']) || DEFAULT_TIMEOUT_MS
    );
    if (!grantHeader || !target)
      return fail('bad_request', 'x-delegate-grant and x-delegate-url are required');
    const provider = str(grantHeader.provider);
    const subject = str(grantHeader.subject) || undefined;
    const accountId = str(grantHeader.accountId) || undefined;
    const pendingHandle = str(grantHeader.pending) || undefined;
    if (!provider || (!subject && !accountId && !pendingHandle)) {
      return fail(
        'bad_request',
        'the grant needs tenantId, provider and a subject, accountId or pending handle'
      );
    }
    const spec = providerSpec(provider);
    if (!spec) return fail('unknown_provider');
    let url: URL;
    try {
      url = new URL(target);
    } catch {
      return fail('bad_request', 'x-delegate-url is not a URL');
    }
    if (!hostAllowed(spec, url, provider))
      return fail('host_not_allowed', `${url.hostname} is not ${provider}`);

    const body = await readBody(request, MAX_REQUEST_BYTES);
    if (body === null) return fail('too_large');

    // The token: a pending exchange's, or the stored grant's (refreshed if due).
    let token: string;
    let retryWithRefresh = false;
    if (pendingHandle) {
      const pending = this.takePending(pendingHandle, provider, false);
      if (!pending) return fail('NO_PENDING');
      token = pending.accessToken;
    } else {
      const access = await this.access(provider, { subject, accountId });
      if (!access.ok) return fail(access.error);
      token = access.grant.accessToken;
      retryWithRefresh = Boolean(access.grant.refreshToken);
    }

    const send = async (
      bearer: string,
      target: URL,
      hopMethod: string,
      hopBody: Buffer
    ): Promise<Response> => {
      const headers = new Headers();
      for (const [name, value] of Object.entries(forwardHeaders)) {
        if (typeof value === 'string' && !FORBIDDEN_REQUEST_HEADERS.has(name.toLowerCase()))
          headers.set(name, value);
      }
      headers.set('authorization', `Bearer ${bearer}`);
      return this.fetchImpl(target, {
        method: hopMethod,
        headers,
        body:
          hopMethod === 'GET' || hopMethod === 'HEAD' || hopBody.byteLength === 0
            ? undefined
            : new Uint8Array(hopBody),
        redirect: 'manual',
        signal: AbortSignal.timeout(timeoutMs),
      });
    };

    let upstream: Response;
    try {
      let current = url;
      let hopMethod = method;
      let hopBody = body;
      for (let hop = 0; ; hop += 1) {
        upstream = await send(token, current, hopMethod, hopBody);
        if (hop === 0 && upstream.status === 401 && retryWithRefresh) {
          const again = await this.access(provider, { subject, accountId }, true);
          if (!again.ok) return fail(again.error);
          token = again.grant.accessToken;
          upstream = await send(token, current, hopMethod, hopBody);
        }
        if (!follow || !isRedirect(upstream.status) || hop >= MAX_REDIRECT_HOPS) break;
        const location = upstream.headers.get('location');
        if (!location) break;
        let next: URL;
        try {
          next = new URL(location, current);
        } catch {
          break;
        }
        // Not the provider's host: the caller gets the redirect and decides;
        // the token goes nowhere near it.
        if (!hostAllowed(spec, next, provider)) break;
        if (
          upstream.status === 303 ||
          ((upstream.status === 301 || upstream.status === 302) &&
            hopMethod !== 'GET' &&
            hopMethod !== 'HEAD')
        ) {
          hopMethod = 'GET';
          hopBody = Buffer.alloc(0);
        }
        await upstream.body?.cancel().catch(() => undefined);
        current = next;
      }
    } catch (error) {
      return fail(
        isTimeout(error) ? 'timeout' : 'unreachable',
        error instanceof Error ? error.message : undefined
      );
    }

    response.statusCode = upstream.status;
    upstream.headers.forEach((value, name) => {
      if (!HOP_BY_HOP.has(name.toLowerCase())) response.setHeader(name, value);
    });
    if (!upstream.body) {
      response.end();
      return;
    }
    // Streamed through, chunk by chunk, with the response's own backpressure.
    const reader = upstream.body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!response.write(value)) {
          await new Promise<void>((resolve) => response.once('drain', resolve));
        }
      }
      response.end();
    } catch {
      response.destroy();
    }
  }

  // ── oauth/exchange, grant/commit ───────────────────────────────────────

  async exchange(body: Record<string, unknown>, response: ServerResponse): Promise<void> {
    const fail = (type: GrantError, message?: string): void =>
      sendJson(response, statusForGrantError(type), { error: { type, message } });
    const provider = str(body.provider);
    const spec = providerSpec(provider);
    if (!spec || !isRecord(body.form))
      return fail(spec ? 'bad_request' : 'unknown_provider');
    const form = new URLSearchParams();
    for (const [key, value] of Object.entries(body.form)) {
      if (typeof value === 'string') form.set(key, value);
    }

    let tokens: Record<string, unknown>;
    if (provider === ONBASE || provider === ONBASE_ADMIN) {
      const answer = await onbaseWorkerCall('token', {
        connector: provider,
        grant: {
          type: 'authorization_code',
          code: form.get('code') ?? '',
          redirectUri: form.get('redirect_uri') ?? '',
          codeVerifier: form.get('code_verifier') ?? '',
        },
      });
      if (!answer.ok)
        return fail(
          answer.err.type === 'UNCONFIGURED' ? 'NOT_CONFIGURED' : 'EXCHANGE_FAILED',
          answer.err.message
        );
      tokens = answer.val;
    } else {
      const config = await providerConfig(spec, this.encryptionKey);
      const clientId = clientIdOf(config);
      const clientSecret = clientSecretOf(config);
      const endpoint = tokenEndpointFor(spec, config, str(body.directoryTenantId) || undefined);
      if (!clientId || !clientSecret || !endpoint) return fail('NOT_CONFIGURED');
      const headers: Record<string, string> = {
        'content-type': 'application/x-www-form-urlencoded',
        accept: 'application/json',
      };
      if (spec.clientAuth === 'basic') {
        headers.authorization = `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`;
      } else {
        form.set('client_id', clientId);
        form.set('client_secret', clientSecret);
      }
      if (!form.has('grant_type')) form.set('grant_type', 'authorization_code');
      let upstream: Response;
      try {
        upstream = await this.fetchImpl(endpoint, {
          method: 'POST',
          headers,
          body: form.toString(),
          signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
        });
      } catch (error) {
        return fail(isTimeout(error) ? 'timeout' : 'unreachable');
      }
      const json: unknown = await upstream.json().catch(() => null);
      if (!upstream.ok || !isRecord(json)) {
        const detail = isRecord(json)
          ? str(json.error_description) || str(json.error)
          : String(upstream.status);
        return fail('EXCHANGE_FAILED', detail);
      }
      tokens = json;
    }

    if (typeof tokens.access_token !== 'string')
      return fail('EXCHANGE_FAILED', 'no access_token in the answer');
    const refreshed = refreshedOf(tokens, '');
    if (!refreshed) return fail('EXCHANGE_FAILED');
    const handle = randomUUID();
    this.sweepPending();
    this.pending.set(handle, {
      provider,
      accessToken: refreshed.accessToken,
      refreshToken: refreshed.refreshToken,
      expiresAt: refreshed.expiresAt,
      idToken: typeof tokens.id_token === 'string' ? tokens.id_token : null,
      scope: typeof tokens.scope === 'string' ? tokens.scope : null,
      createdAt: Date.now(),
    });
    // Bitbucket echoes `scopes`, everyone else `scope`; relayed as given so the
    // caller can record what was actually granted for an opaque token.
    const scopeEcho =
      typeof tokens.scope === 'string'
        ? tokens.scope
        : typeof tokens.scopes === 'string'
          ? tokens.scopes
          : null;
    sendJson(response, 200, {
      handle,
      expiresAt: refreshed.expiresAt.toISOString(),
      scope: scopeEcho,
      idToken: typeof tokens.id_token === 'string' ? tokens.id_token : null,
      grantedScopes: scopesFromAccessToken(refreshed.accessToken),
      hasRefreshToken: refreshed.refreshToken !== '',
    });
  }

  async commit(body: Record<string, unknown>, response: ServerResponse): Promise<void> {
    const fail = (type: GrantError, message?: string): void =>
      sendJson(response, statusForGrantError(type), { error: { type, message } });
    const provider = str(body.provider);
    const handle = str(body.handle);
    const subject = str(body.subject);
    const accountId = str(body.accountId);
    const displayName = str(body.displayName);
    if (!provider || !handle || !subject || !accountId) return fail('bad_request');
    const spec = providerSpec(provider);
    if (!spec) return fail('unknown_provider');
    const pending = this.takePending(handle, provider, true);
    if (!pending) return fail('NO_PENDING');
    const config = await providerConfig(spec, this.encryptionKey);
    const requestedScopes = Array.isArray(body.requestedScopes)
      ? body.requestedScopes.filter((scope): scope is string => typeof scope === 'string')
      : [];
    const saved = await setGrant(provider, {
      accountId,
      clientId: str(body.clientId) || clientIdOf(config),
      displayName,
      accessToken: pending.accessToken,
      refreshToken: pending.refreshToken,
      expiresAt: pending.expiresAt.toISOString(),
      requestedScopes,
      // Decoded from the token when it is a JWT; for an opaque token the
      // caller may pass what the provider's exchange answer said was granted.
      grantedScopes:
        scopesFromAccessToken(pending.accessToken) ??
        (Array.isArray(body.grantedScopes)
          ? body.grantedScopes.filter((scope): scope is string => typeof scope === 'string')
          : null),
      metadata: isRecord(body.metadata) ? body.metadata : {},
      subject,
    });
    if (!saved.ok) return fail('GRANT_UNREADABLE', 'the grant could not be stored');
    sendJson(response, 200, { ok: true, accountId });
  }

  // ── grant/describe, grant/revoke, grant/delete ─────────────────────────

  async describeOp(body: Record<string, unknown>, response: ServerResponse): Promise<void> {
    const provider = str(body.provider);
    const subject = str(body.subject) || undefined;
    const accountId = str(body.accountId) || undefined;
    if (!provider || (!subject && !accountId)) {
      return sendJson(response, 400, { error: { type: 'bad_request' } });
    }
    const row = await grantRow(this.db, provider, { subject, accountId });
    if (!row) return sendJson(response, 404, { error: { type: 'NO_GRANT' } });
    const read = await getGrant(provider, row.provider_account_id);
    if (!read.ok || !read.val)
      return sendJson(response, 502, { error: { type: 'GRANT_UNREADABLE' } });
    sendJson(response, 200, describe(read.val));
  }

  async revoke(body: Record<string, unknown>, response: ServerResponse): Promise<void> {
    const provider = str(body.provider);
    const accountId = str(body.accountId);
    if (!provider || !accountId)
      return sendJson(response, 400, { error: { type: 'bad_request' } });
    const spec = providerSpec(provider);
    if (!spec) return sendJson(response, 404, { error: { type: 'unknown_provider' } });

    // Best effort at the provider while we still hold the token; deleting
    // our copy is what matters.
    let revokedAtProvider = false;
    const read = await getGrant(provider, accountId);
    if (read.ok && read.val) {
      const grant = read.val;
      try {
        if (provider === ZOOM) {
          const config = await providerConfig(spec, this.encryptionKey);
          const clientId = clientIdOf(config);
          const clientSecret = clientSecretOf(config);
          if (clientId && clientSecret) {
            const answer = await this.fetchImpl('https://zoom.us/oauth/revoke', {
              method: 'POST',
              headers: {
                authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
                'content-type': 'application/x-www-form-urlencoded',
              },
              body: new URLSearchParams({ token: grant.accessToken }).toString(),
              signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
            });
            revokedAtProvider = answer.ok;
          }
        } else if (provider === ONBASE || provider === ONBASE_ADMIN) {
          const token = grant.refreshToken || grant.accessToken;
          const answer = await onbaseWorkerCall('revoke', {
            connector: provider,
            token,
            tokenTypeHint: grant.refreshToken ? 'refresh_token' : 'access_token',
          });
          revokedAtProvider = answer.ok && answer.val.revoked === true;
        }
      } catch (error) {
        this.logger.warn('provider revocation failed; deleting the grant regardless', {
          component: 'worker-delegate/grants',
          provider,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    const deleted = await deleteGrant(provider, accountId);
    if (!deleted.ok) return sendJson(response, 500, { error: { type: 'internal' } });
    sendJson(response, 200, { ok: true, revokedAtProvider });
  }

  async deleteOp(body: Record<string, unknown>, response: ServerResponse): Promise<void> {
    const provider = str(body.provider);
    const accountId = str(body.accountId);
    if (!provider || !accountId)
      return sendJson(response, 400, { error: { type: 'bad_request' } });
    const deleted = await deleteGrant(provider, accountId);
    if (!deleted.ok) return sendJson(response, 500, { error: { type: 'internal' } });
    sendJson(response, 200, { ok: true });
  }

  // ── pending exchanges ──────────────────────────────────────────────────

  private takePending(
    handle: string,
    provider: string,
    consume: boolean
  ): Pending | null {
    this.sweepPending();
    const pending = this.pending.get(handle);
    if (!pending || pending.provider !== provider) return null;
    if (consume) this.pending.delete(handle);
    return pending;
  }

  private sweepPending(): void {
    const cutoff = Date.now() - PENDING_TTL_MS;
    for (const [handle, pending] of this.pending) {
      if (pending.createdAt < cutoff) this.pending.delete(handle);
    }
  }
}

function parseJsonHeader(value: string | string[] | undefined): Record<string, unknown> | null {
  const text = Array.isArray(value) ? value[0] : value;
  if (!text) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function isTimeout(error: unknown): boolean {
  return error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
}
