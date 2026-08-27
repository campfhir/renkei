/**
 * OIDC discovery for the Hyland IdP. Pure parsing only — the fetch itself
 * happens in the OnBase egress worker, the one process allowed to dial the
 * customer's network. Keeping the URL derivation and document validation
 * here means the worker and its tests share one reading of the spec.
 */

import { ok, err } from '@campfhir/safe-functions/helpers';
import type { Result } from '@campfhir/safe-functions/types';
import type { OnBaseIdpEndpoints } from './types';

export type DiscoveryError = 'INVALID_ISSUER' | 'MALFORMED_DISCOVERY';

/**
 * The well-known discovery URL for an issuer. The issuer must be an
 * absolute http(s) URL; RFC 8414 appends the well-known path after any
 * issuer path component.
 */
export function oidcDiscoveryUrl(issuer: string): Result<string, DiscoveryError> {
  let url: URL;
  try {
    url = new URL(issuer);
  } catch {
    return err('INVALID_ISSUER' as const);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return err('INVALID_ISSUER' as const);
  }
  const base = url.origin + url.pathname.replace(/\/+$/, '');
  return ok(`${base}/.well-known/openid-configuration`);
}

/**
 * Validate a discovery document down to the endpoints Renkei uses. The
 * authorization and token endpoints are required — a document without them
 * cannot serve the code flow; the revocation endpoint is optional and its
 * absence just makes disconnect best-effort-less.
 */
export function parseDiscoveryDocument(value: unknown): Result<OnBaseIdpEndpoints, DiscoveryError> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return err('MALFORMED_DISCOVERY' as const);
  }
  const record: Record<string, unknown> = { ...value };
  const issuer = stringField(record, 'issuer');
  const authorizationEndpoint = urlField(record, 'authorization_endpoint');
  const tokenEndpoint = urlField(record, 'token_endpoint');
  if (!issuer || !authorizationEndpoint || !tokenEndpoint) {
    return err('MALFORMED_DISCOVERY' as const);
  }
  const revocationEndpoint = urlField(record, 'revocation_endpoint');
  return ok({
    issuer,
    authorizationEndpoint,
    tokenEndpoint,
    ...(revocationEndpoint ? { revocationEndpoint } : {}),
  });
}

function stringField(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function urlField(record: Record<string, unknown>, key: string): string | null {
  const value = stringField(record, key);
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  } catch {
    return null;
  }
  return value;
}
