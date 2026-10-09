/**
 * `guardedFetch` — the request half of the egress guard (egress-guard.ts
 * has the checks). A plain `fetch(url)` after `assertPublicHttpsUrl(url)`
 * leaves two doors open that the check itself cannot close:
 *
 *  - **Redirects.** fetch follows a Location on its own, and only the first
 *    URL was checked — a public page answering `302 Location:
 *    http://169.254.169.254/...` walks straight past the guard. Here
 *    redirects are followed BY HAND, at most `GUARDED_FETCH_MAX_REDIRECTS`
 *    hops, every Location run through the same structural check and
 *    resolution as the first URL (so an http:// downgrade, a private
 *    literal or a name that resolves privately are all refused), with the
 *    method semantics a browser would apply (303, and 301/302 on anything
 *    but GET/HEAD, become a bodiless GET; 307/308 keep method and body)
 *    and the credential headers dropped when the host changes.
 *
 *  - **DNS rebinding.** The check resolves the name; fetch resolves it
 *    AGAIN to connect, and a name that answered publicly the first time
 *    can answer privately the second. Here the socket is dialled at the
 *    very address the resolution verified — the TLS server name and the
 *    Host header stay the original hostname, so certificate validation and
 *    virtual hosting are untouched — exactly as the browser's egress proxy
 *    (apps/worker-sandbox/src/browser-proxy.ts) does for Chromium.
 *
 * Built on node:https directly rather than an undici dispatcher: this
 * package has no undici dependency (Node's own fetch bundles a private
 * copy), and a pinned `host` + `servername` on https.request is the whole
 * of what a connect-time dispatcher would add. The transport and the
 * resolver are injectable so the redirect and pinning contract is tested
 * without a network.
 */

import { request as httpsRequest } from 'node:https';
import { Readable } from 'node:stream';
import { assertSafeHttpsUrl, BlockedUrlError, resolvePublicAddress } from './egress-guard';

/** The most redirect hops a guarded fetch follows before refusing. */
export const GUARDED_FETCH_MAX_REDIRECTS = 5;

export interface GuardedFetchInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string | Uint8Array | URLSearchParams | null;
  /** Aborting it fails the fetch with the signal's reason, as fetch would. */
  signal?: AbortSignal;
  /** Redirect hops allowed; the default is the module's ceiling, and it cannot be raised. */
  maxRedirects?: number;
}

/** What the transport dials: a URL and the ONE address verified for its host. */
export interface GuardedTransportRequest {
  url: URL;
  /** The IP the socket must connect to — never re-resolved from `url.hostname`. */
  address: string;
  method: string;
  /** Lower-cased names; `host` is already set to the URL's host. */
  headers: Record<string, string>;
  body: Uint8Array | null;
  signal?: AbortSignal;
}

export interface GuardedTransportResponse {
  status: number;
  statusText: string;
  headers: Record<string, string | string[] | undefined>;
  /** The body stream, or null when there is none. */
  body: Readable | null;
}

export type GuardedTransport = (
  request: GuardedTransportRequest
) => Promise<GuardedTransportResponse>;

export interface GuardedFetchDeps {
  /** Test seam: the default applies the guard to a real DNS lookup. */
  resolve?: (hostname: string) => Promise<string>;
  /** Test seam: the default dials node:https at the verified address. */
  transport?: GuardedTransport;
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
/** Headers that must not follow a redirect to another host. */
const CREDENTIAL_HEADERS = ['authorization', 'cookie', 'proxy-authorization'];
/** Headers that describe a body and go when the body does. */
const BODY_HEADERS = ['content-type', 'content-length', 'content-encoding', 'transfer-encoding'];
/** Statuses whose Response may carry no body. */
const BODILESS_STATUSES = new Set([101, 204, 205, 304]);

function abortError(signal: AbortSignal): Error {
  const reason: unknown = signal.reason;
  if (reason instanceof Error) return reason;
  const error = new Error('This operation was aborted');
  error.name = 'AbortError';
  return error;
}

/**
 * node:https at the verified address: `host` is the IP, `servername` the
 * hostname (so the certificate is checked against the name, not the
 * address), and the Host header the URL's own.
 */
export const httpsTransport: GuardedTransport = (input) =>
  new Promise((resolve, reject) => {
    const bare = input.url.hostname.replace(/^\[/, '').replace(/\]$/, '');
    const request = httpsRequest({
      host: input.address,
      port: input.url.port ? Number(input.url.port) : 443,
      // An IP literal has no name to check a certificate against; a
      // hostname is verified as the name the caller asked for.
      ...(bare === input.address ? {} : { servername: bare }),
      method: input.method,
      path: `${input.url.pathname}${input.url.search}`,
      headers: input.headers,
      setHost: false,
    });
    const onAbort = (): void => {
      request.destroy(abortError(input.signal!));
    };
    input.signal?.addEventListener('abort', onAbort, { once: true });
    request.once('response', (response) => {
      input.signal?.removeEventListener('abort', onAbort);
      if (input.signal) {
        // A later abort must still end the body the caller is reading.
        input.signal.addEventListener('abort', () => response.destroy(abortError(input.signal!)), {
          once: true,
        });
      }
      resolve({
        status: response.statusCode ?? 0,
        statusText: response.statusMessage ?? '',
        headers: response.headers,
        body: response,
      });
    });
    request.once('error', (error) => {
      input.signal?.removeEventListener('abort', onAbort);
      reject(error);
    });
    if (input.body) request.end(input.body);
    else request.end();
  });

function bodyBytes(body: GuardedFetchInit['body']): Uint8Array | null {
  if (body === undefined || body === null) return null;
  if (typeof body === 'string') return Buffer.from(body, 'utf8');
  if (body instanceof URLSearchParams) return Buffer.from(body.toString(), 'utf8');
  return body;
}

function lowerCased(headers: Record<string, string> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers ?? {})) out[name.toLowerCase()] = value;
  return out;
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function toResponse(upstream: GuardedTransportResponse, method: string): Response {
  const headers = new Headers();
  for (const [name, value] of Object.entries(upstream.headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) for (const entry of value) headers.append(name, entry);
    else headers.set(name, value);
  }
  const bodiless = method === 'HEAD' || BODILESS_STATUSES.has(upstream.status);
  if (bodiless) upstream.body?.resume();
  const body =
    bodiless || !upstream.body
      ? null
      : // Response wants a WHATWG stream; Readable.toWeb bridges Node's.
        // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
        (Readable.toWeb(upstream.body) as ReadableStream<Uint8Array>);
  // Response refuses a status outside 200–599; an upstream speaking
  // anything else is answered as a bad gateway rather than thrown at the caller.
  const status = upstream.status >= 200 && upstream.status <= 599 ? upstream.status : 502;
  return new Response(body, { status, statusText: upstream.statusText, headers });
}

/**
 * fetch() with the egress guard applied to the first URL AND every redirect
 * it answers with, each hop dialled at the address verified for it.
 * Throws BlockedUrlError for a refused URL (the first or a Location), a
 * downgrade to http://, or a chain longer than the ceiling; any other
 * failure is the transport's own error.
 */
export async function guardedFetch(
  raw: string,
  init: GuardedFetchInit = {},
  deps: GuardedFetchDeps = {}
): Promise<Response> {
  const resolve = deps.resolve ?? resolvePublicAddress;
  const transport = deps.transport ?? httpsTransport;
  const maxRedirects = Math.min(
    GUARDED_FETCH_MAX_REDIRECTS,
    Math.max(0, Math.floor(init.maxRedirects ?? GUARDED_FETCH_MAX_REDIRECTS))
  );

  let url = assertSafeHttpsUrl(raw);
  let method = (init.method ?? 'GET').toUpperCase();
  let body = bodyBytes(init.body);
  const headers = lowerCased(init.headers);
  if (body && !('content-length' in headers)) headers['content-length'] = String(body.byteLength);

  for (let hop = 0; ; hop += 1) {
    if (init.signal?.aborted) throw abortError(init.signal);
    const address = await resolve(url.hostname);
    const upstream = await transport({
      url,
      address,
      method,
      headers: { ...headers, host: url.host },
      body,
      signal: init.signal,
    });

    const location = firstHeader(upstream.headers.location);
    if (!REDIRECT_STATUSES.has(upstream.status) || !location) {
      return toResponse(upstream, method);
    }
    upstream.body?.resume();
    if (hop >= maxRedirects) {
      throw new BlockedUrlError(`too many redirects (more than ${maxRedirects})`);
    }

    let next: URL;
    try {
      next = new URL(location, url);
    } catch {
      throw new BlockedUrlError('redirect target is not a valid URL');
    }
    // The same checks the first URL passed: https only (so a Location to
    // http:// is a refused downgrade), no localhost family, no private
    // literal; the resolution at the top of the next hop covers names.
    const target = assertSafeHttpsUrl(next.href);
    if (target.host !== url.host) {
      for (const name of CREDENTIAL_HEADERS) delete headers[name];
    }
    const toGet =
      upstream.status === 303 ||
      ((upstream.status === 301 || upstream.status === 302) &&
        method !== 'GET' &&
        method !== 'HEAD');
    if (toGet) {
      method = 'GET';
      body = null;
      for (const name of BODY_HEADERS) delete headers[name];
    }
    url = target;
  }
}
