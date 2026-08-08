import { NextRequest } from 'next/server';
import { getPublicBaseUrl } from '@renkei/settings';
import { ok } from '@campfhir/safe-functions/helpers';
import type { Result } from '@campfhir/safe-functions/types';

/**
 * Get the origin/base URL for the application.
 *
 * Resolution order:
 * 1. PUBLIC_BASE_URL from the environment — the deployment's declared
 *    address. When set, it is authoritative: it is the address registered
 *    with every OAuth provider, so nothing derived per-request may override
 *    it. It is also the only source available with no request in hand
 *    (server components, the worker).
 * 2. X-Forwarded-* headers — how the reverse proxy says the request arrived.
 *    Trusted, because the deployment contract is that this app always stands
 *    behind a proxy the operator controls; verifying the proxy per-request is
 *    not possible anyway (a route handler gets a Web-standard Request with no
 *    socket underneath, and X-Forwarded-For carries what each hop appended —
 *    the peer it saw — which for a single proxy is the client, not the
 *    proxy). Do not publish the app port to untrusted clients directly.
 * 3. Request URL — bare local development, where the browser talks to the
 *    app directly and the Host header is its own.
 *
 * None of this comes from the database, deliberately. The origin gates the
 * OIDC redirect_uri, so it must resolve correctly before anyone can
 * authenticate — a setting reachable only behind sign-in cannot configure
 * sign-in, and a database row silently vanishes with a database rebuild.
 */
export async function getOrigin(request?: NextRequest): Promise<Result<string, 'CONFIG_ERROR'>> {
  // Priority 1: the deployment's declared address.
  const configured = getPublicBaseUrl();
  if (configured) {
    return ok(configured);
  }

  // Priority 2: what the reverse proxy says this request's origin was.
  if (request) {
    const forwardedProto = request.headers.get('x-forwarded-proto');
    const forwardedHost = request.headers.get('x-forwarded-host');
    if (forwardedProto && forwardedHost) {
      return ok(`${forwardedProto}://${forwardedHost}`);
    }
  }

  if (!request) {
    // No request to derive from and nothing configured.
    return ok('http://localhost:3000');
  }

  // Priority 3: derive from the request URL.
  const url = new URL(request.url);
  return ok(`${url.protocol}//${url.host}`);
}
