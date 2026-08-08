import { NextRequest } from 'next/server';
import { getPublicBaseUrl } from '@renkei/settings';
import { ok } from '@campfhir/safe-functions/helpers';
import type { Result } from '@campfhir/safe-functions/types';

/**
 * Get the origin/base URL for the application.
 *
 * Resolution order:
 * 1. X-Forwarded-* headers — the live truth of how this request reached us.
 * 2. PUBLIC_BASE_URL from the environment — the deployment's declared address,
 *    and the only source available with no request in hand (server components,
 *    the worker).
 * 3. Request URL (development fallback).
 *
 * The forwarding headers are trusted unconditionally: this app's deployment
 * contract is that it always stands behind a reverse proxy the operator
 * controls, with its own port published only where that proxy can reach it.
 * Verifying the proxy per-request is not possible anyway — a route handler
 * gets a Web-standard Request with no socket underneath, so the peer's
 * address is never visible, and X-Forwarded-For carries what each hop
 * appended (the peer it saw), which for a single proxy is the client, not the
 * proxy. Exposing the app port directly to untrusted clients would let them
 * choose the origin here; don't.
 *
 * None of this comes from the database, deliberately. The origin gates the
 * OIDC redirect_uri, so it must resolve correctly before anyone can
 * authenticate — a setting reachable only behind sign-in cannot configure
 * sign-in, and a database row silently vanishes with a database rebuild.
 */
export async function getOrigin(request?: NextRequest): Promise<Result<string, 'CONFIG_ERROR'>> {
  // Priority 1: what the reverse proxy says this request's origin was.
  if (request) {
    const forwardedProto = request.headers.get('x-forwarded-proto');
    const forwardedHost = request.headers.get('x-forwarded-host');
    if (forwardedProto && forwardedHost) {
      return ok(`${forwardedProto}://${forwardedHost}`);
    }
  }

  // Priority 2: the deployment's declared address.
  const configured = getPublicBaseUrl();
  if (configured) {
    return ok(configured);
  }

  if (!request) {
    // No request to derive from and nothing configured.
    return ok('http://localhost:3000');
  }

  // Priority 3: derive from the request URL — local development, where the
  // browser talks to the app directly and the Host header is its own.
  const url = new URL(request.url);
  return ok(`${url.protocol}//${url.host}`);
}
