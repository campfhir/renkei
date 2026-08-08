import { NextRequest } from 'next/server';
import { getPublicBaseUrl } from '@renkei/settings';
import { ok } from '@campfhir/safe-functions/helpers';
import type { Result } from '@campfhir/safe-functions/types';

/**
 * Get the origin/base URL for the application, respecting reverse proxies securely.
 *
 * Resolution order:
 * 1. X-Forwarded-* headers, ONLY when the request comes through a whitelisted
 *    proxy IP — the live truth of how this request actually reached us.
 * 2. PUBLIC_BASE_URL from the environment — the deployment's declared address,
 *    and the only source available with no request in hand (server components,
 *    the worker).
 * 3. Request URL (as fallback, but logs warning).
 *
 * None of this comes from the database, deliberately. The origin gates the
 * OIDC redirect_uri, so it must resolve correctly before anyone can
 * authenticate — a setting reachable only behind sign-in cannot configure
 * sign-in, and a database row silently vanishes with a database rebuild.
 *
 * X-Forwarded headers are only trusted when:
 * - Request comes from a whitelisted proxy IP
 * - Both X-Forwarded-Proto and X-Forwarded-Host are present
 */
export async function getOrigin(request?: NextRequest): Promise<Result<string, 'CONFIG_ERROR'>> {
  // Priority 1: what the trusted proxy says this request's origin was.
  if (request) {
    const forwardedProto = request.headers.get('x-forwarded-proto');
    const forwardedHost = request.headers.get('x-forwarded-host');

    if (forwardedProto && forwardedHost && isTrustedProxy(request)) {
      const origin = `${forwardedProto}://${forwardedHost}`;
      console.log(`[getOrigin] Using X-Forwarded headers from trusted proxy: ${origin}`);
      return ok(origin);
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
      `[getOrigin] X-Forwarded headers detected but source IP not whitelisted. Using request URL instead: ${origin}. ` +
        `If behind a proxy, set TRUSTED_PROXY_IPS in env.`
    );
  }

  return ok(origin);
}

/**
 * Check if the request comes from a whitelisted proxy IP.
 *
 * TRUSTED_PROXY_IPS stays an environment variable deliberately: whether to
 * believe a request's forwarding headers must be decided before anything
 * from the database can be trusted to have been reached correctly.
 */
function isTrustedProxy(request: NextRequest): boolean {
  // Get client IP from various headers (in order of precedence)
  const clientIp =
    request.headers.get('x-forwarded-for')?.split(',')[0].trim() ||
    request.headers.get('x-real-ip') ||
    request.headers.get('cf-connecting-ip') ||
    'unknown';

  // Get configured whitelist (default: localhost only for safety)
  const trustedIpsEnv = process.env.TRUSTED_PROXY_IPS || '127.0.0.1,::1';
  const trustedIps = trustedIpsEnv.split(',').map((ip) => ip.trim());

  // Check if client IP matches whitelist
  const isTrusted = trustedIps.some((trustedIp) => {
    // Simple IP matching (handles CIDR notation minimally for basic cases)
    if (trustedIp === clientIp) return true;

    // Handle localhost aliases
    if (
      (trustedIp === '127.0.0.1' || trustedIp === 'localhost') &&
      (clientIp === '127.0.0.1' || clientIp === 'localhost' || clientIp === '::1')
    ) {
      return true;
    }

    // Docker: 172.17.0.0/16 is Docker's default bridge network
    if (trustedIp === '172.17.0.1' && clientIp.startsWith('172.17.')) return true;

    return false;
  });

  if (!isTrusted) {
    console.warn(
      `[getOrigin] X-Forwarded headers received from untrusted IP: ${clientIp}. ` +
        `Configured trusted IPs: ${trustedIpsEnv}. Ignoring headers.`
    );
  }

  return isTrusted;
}
