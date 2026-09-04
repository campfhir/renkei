/**
 * Tenant OnBase configuration, as this worker reads it. The single
 * `connector_configs` row keyed `onbase` is the only place the customer's
 * API server URL and IdP registration live; resolving it HERE — never
 * accepting a host from the request body — is what keeps the bearer seam
 * from becoming an open proxy: a caller can name a tenant, not a URL.
 * (`test-connection` is the one deliberate exception, and it re-validates
 * the unsaved values with the same parser.)
 */

import { ok, err } from '@campfhir/safe-functions/helpers';
import type { Result } from '@campfhir/safe-functions/types';
import { getConnectorConfig } from '@renkei/connector-config';

export const ONBASE_CONNECTOR = 'onbase';

export interface OnBaseTenantConfig {
  /** Normalized, no trailing slash — paths append directly. */
  apiBaseUrl: string;
  idpIssuer: string;
  clientId: string;
  /** Null for a public PKCE client. */
  clientSecret: string | null;
  idpScopeName: string;
  allowInsecureHttp: boolean;
  /**
   * The OnBase Administration API base (`{server}/onbase/administration`,
   * sibling to the Document API's `{server}/onbase/core`) — optional and
   * separately configured, since a tenant that connects OnBase for document
   * retrieval need not also grant configuration access. Null means the
   * onbase_admin_* tools are unavailable for this tenant; the same Bearer
   * token authenticates both APIs, so no separate grant is needed once set.
   */
  adminApiBaseUrl: string | null;
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

export async function resolveOnBaseConfig(
  tenantId: string,
  encryptionKey: Buffer
): Promise<Result<OnBaseTenantConfig, ConfigError>> {
  const config = await getConnectorConfig(tenantId, ONBASE_CONNECTOR, encryptionKey);
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
  // Optional: an operator who has not set it simply has no onbase_admin_*
  // tools, never a broken Document API connection.
  const adminApiBaseUrl = parseHttpUrl(settings.adminApiBaseUrl, allowInsecureHttp);
  return ok({
    apiBaseUrl,
    idpIssuer,
    clientId,
    clientSecret: config.val.secrets.clientSecret || null,
    idpScopeName,
    allowInsecureHttp,
    adminApiBaseUrl,
  });
}
