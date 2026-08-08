import { NextRequest } from 'next/server';
import { getPublicBaseUrl } from '@renkei/settings';
import { ok } from '@campfhir/safe-functions/helpers';
import type { Result } from '@campfhir/safe-functions/types';

/**
 * Get the origin/base URL for the application, respecting reverse proxies securely.
 *
 * Resolution order:
 * 1. X-Forwarded-* headers, when TRUST_PROXY_HEADERS says the deployment
 *    stands behind a reverse proxy — the live truth of how this request
 *    actually reached us.
 * 2. PUBLIC_BASE_URL from the environment — the deployment's declared address,
 *    and the only source available with no request in hand (server components,
 *    the worker).
 * 3. Request URL (as fallback, but logs warning).
 *
 * None of this comes from the database, deliberately. The origin gates the
 * OIDC redirect_uri, so it must resolve correctly before anyone can
 * authenticate — a setting reachable only behind sign-in cannot configure
 * sign-in, and a database row silently vanishes with a database rebuild.
 */
export async function getOrigin(request?: NextRequest): Promise<Result<string, 'CONFIG_ERROR'>> {
  // Priority 1: what the reverse proxy says this request's origin was.
  if (request && trustProxyHeaders()) {
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

  // Priority 3: Extract from request URL (development fallback)
  // This is less safe as clients could manipulate Host header
  const url = new URL(request.url);
  const origin = `${url.protocol}//${url.host}`;

  if (request.headers.get('x-forwarded-proto') || request.headers.get('x-forwarded-host')) {
    console.warn(
      `[getOrigin] X-Forwarded headers present but not trusted. Using request URL instead: ${origin}. ` +
        `If the app is only reachable through your reverse proxy, set TRUST_PROXY_HEADERS=true.`
    );
  }

  return ok(origin);
}

/**
 * Whether forwarding headers are believed — a deployment assertion, not an
 * IP check, because an IP check is not possible here. A route handler gets a
 * Web-standard Request with no socket underneath, so the proxy's address (the
 * one thing worth verifying) is never visible; X-Forwarded-For only ever
 * carries what each hop APPENDED — the peer it saw — so a single proxy writes
 * the client's address, not its own. The previous TRUSTED_PROXY_IPS whitelist
 * therefore compared end-user IPs against a list of proxy IPs and rejected
 * everything.
 *
 * What actually makes these headers trustworthy is topology: the app's port
 * published only to localhost or an internal network, so nothing but the
 * proxy can reach it at all. That is a fact about the deployment, asserted
 * here as one.
 */
function trustProxyHeaders(): boolean {
  const value = process.env.TRUST_PROXY_HEADERS?.trim().toLowerCase();
  return value === 'true' || value === '1';
}
