/**
 * Tenant OnBase configuration, as this worker reads it. Two separate
 * `connector_configs` rows — keyed `onbase` (Document Management API) and
 * `onbase-admin` (Administration API) — are the only place a customer's API
 * server URLs and IdP registrations live; resolving them HERE — never
 * accepting a host from the request body — is what keeps the bearer seam
 * from becoming an open proxy: a caller can name a tenant and a connector,
 * not a URL. (`test-connection` is the one deliberate exception, and it
 * re-validates the unsaved values with the same parser.)
 *
 * The two rows are independent Hyland OAuth clients with independent
 * configuration, mirroring how connector-atlassian resolves a separate row
 * per Atlassian product — there is no sharing to be had here, because a
 * tenant may configure and connect one without the other.
 */

import { ok, err } from '@campfhir/safe-functions/helpers';
import type { Result } from '@campfhir/safe-functions/types';
import { getConnectorConfig } from '@renkei/connector-config';

export const ONBASE_CONNECTOR = 'onbase';
export const ONBASE_ADMIN_CONNECTOR = 'onbase-admin';

export interface OnBaseTenantConfig {
  /** Normalized, no trailing slash — paths append directly. */
  apiBaseUrl: string;
  idpIssuer: string;
  clientId: string;
  /** Null for a public PKCE client. */
  clientSecret: string | null;
  idpScopeName: string;
  allowInsecureHttp: boolean;
}

export type ConfigError = 'not_configured' | 'store';

/**
 * Parse a customer-supplied base URL. HTTPS is required unless the operator
 * has explicitly saved `allowInsecureHttp` — an on-prem lab server without
 * TLS is real, but running bearer tokens over plaintext must be a recorded
 * decision, not a default.
 */
export function parseHttpUrl(value: unknown, allowInsecureHttp: boolean): string | null {
  if (typeof value !== 'string' || value.length === 0) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && !(allowInsecureHttp && url.protocol === 'http:')) return null;
  if (url.username || url.password) return null;
  if (url.search || url.hash) return null;
  return url.origin + url.pathname.replace(/\/+$/, '');
}

/**
 * @param connector Which `connector_configs` row to resolve — `onbase`
 *   (default, the Document Management API) or `onbase-admin` (the
 *   Administration API). Both rows have the identical shape, so this one
 *   function and one `OnBaseTenantConfig` type serve either.
 */
export async function resolveOnBaseConfig(
  tenantId: string,
  encryptionKey: Buffer,
  connector: string = ONBASE_CONNECTOR
): Promise<Result<OnBaseTenantConfig, ConfigError>> {
  const config = await getConnectorConfig(tenantId, connector, encryptionKey);
  if (!config.ok) return err('store' as const);
  if (!config.val || !config.val.enabled) return err('not_configured' as const);

  const settings = config.val.settings;
  const allowInsecureHttp = settings.allowInsecureHttp === true;
  const apiBaseUrl = parseHttpUrl(settings.apiBaseUrl, allowInsecureHttp);
  const idpIssuer = parseHttpUrl(settings.idpIssuer, allowInsecureHttp);
  const clientId = typeof settings.clientId === 'string' ? settings.clientId : '';
  const idpScopeName = typeof settings.idpScopeName === 'string' ? settings.idpScopeName : '';
  if (!apiBaseUrl || !idpIssuer || !clientId || !idpScopeName) {
    return err('not_configured' as const);
  }
  return ok({
    apiBaseUrl,
    idpIssuer,
    clientId,
    clientSecret: config.val.secrets.clientSecret || null,
    idpScopeName,
    allowInsecureHttp,
  });
}
