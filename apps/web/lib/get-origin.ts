import { NextRequest } from 'next/server';
import { getPublicBaseUrl } from '@renkei/settings';
import { ok } from '@campfhir/safe-functions/helpers';
import type { Result } from '@campfhir/safe-functions/types';

/**
 * Get the origin/base URL for the application, respecting reverse proxies securely.
 *
 * Uses a defensive strategy to prevent header spoofing:
 * 1. The platform's public_base_url setting (most trustworthy — configured by
 *    an org-admin, stored in the database)
 * 2. X-Forwarded-* headers ONLY if from whitelisted proxy IPs
 * 3. Request URL (as fallback, but logs warning)
 *
 * The database being unset (or unreachable) falls through to the header
 * chain rather than failing: origin resolution is also how the very first
 * sign-in reaches the deployment before anything has been configured.
 *
 * X-Forwarded headers are only trusted when:
 * - Request comes from a whitelisted proxy IP
 * - Both X-Forwarded-Proto and X-Forwarded-Host are present
 */
export async function getOrigin(request?: NextRequest): Promise<Result<string, 'CONFIG_ERROR'>> {
  // Priority 1: the stored public base URL is the single source of truth.
  const configured = await getPublicBaseUrl();
  if (configured.ok && configured.val) {
    return ok(configured.val);
  }

  if (!request) {
    // No request to derive from and nothing configured.
    return ok('http://localhost:3000');
  }

  // Priority 2: Check X-Forwarded headers ONLY from trusted proxies
  const forwardedProto = request.headers.get('x-forwarded-proto');
  const forwardedHost = request.headers.get('x-forwarded-host');

  if (forwardedProto && forwardedHost && isTrustedProxy(request)) {
    const origin = `${forwardedProto}://${forwardedHost}`;
    console.log(`[getOrigin] Using X-Forwarded headers from trusted proxy: ${origin}`);
    return ok(origin);
  }

  // Priority 3: Extract from request URL (development fallback)
  // This is less safe as clients could manipulate Host header
  const url = new URL(request.url);
  const origin = `${url.protocol}//${url.host}`;

  if (forwardedProto || forwardedHost) {
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
  const trustedIps = trustedIpsEnv.split(',').map(ip => ip.trim());

  // Check if client IP matches whitelist
  const isTrusted = trustedIps.some(trustedIp => {
    // Simple IP matching (handles CIDR notation minimally for basic cases)
    if (trustedIp === clientIp) return true;

    // Handle localhost aliases
    if ((trustedIp === '127.0.0.1' || trustedIp === 'localhost') &&
        (clientIp === '127.0.0.1' || clientIp === 'localhost' || clientIp === '::1')) {
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
