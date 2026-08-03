/**
 * The two discovery documents an MCP client fetches before it can authorize.
 *
 * The chain: the client hits /mcp without a token, gets a 401 carrying
 * `WWW-Authenticate: Bearer resource_metadata="…"`, fetches that document to
 * learn which authorization server to use, fetches *its* metadata to learn the
 * endpoints, registers itself if it has to, and only then starts the flow.
 * Getting any link wrong presents as "the connector won't connect" with no
 * further detail, so each field below is load-bearing.
 */

import { formatScope, supportedScopes } from './scopes.js';

export interface MetadataOptions {
  publicBaseUrl: string;
  readOnly: boolean;
  enableDcr: boolean;
  /** Absent means the bare `/mcp`. */
  tenantSiteId?: string;
}

/** Trailing slashes in PUBLIC_BASE_URL would double up in every derived URL. */
function base(publicBaseUrl: string): string {
  return publicBaseUrl.replace(/\/+$/, '');
}

/**
 * The RFC 8707 audience for an endpoint. Omitting the site gives the bare
 * `/mcp`, which is the deployment's configured tenant.
 */
export function mcpResourceUrl(publicBaseUrl: string, tenantSiteId?: string): string {
  const root = `${base(publicBaseUrl)}/mcp`;
  return tenantSiteId === undefined ? root : `${root}/${tenantSiteId}`;
}

/**
 * Clients derive this path from the resource URL's own path, so a resource of
 * `/mcp/<id>` is discovered at `/.well-known/oauth-protected-resource/mcp/<id>`.
 * Getting the two out of step presents as a connector that will not connect,
 * with no further detail.
 */
export function protectedResourceMetadataUrl(publicBaseUrl: string, tenantSiteId?: string): string {
  const root = `${base(publicBaseUrl)}/.well-known/oauth-protected-resource`;
  return tenantSiteId === undefined ? root : `${root}/mcp/${tenantSiteId}`;
}

/**
 * Pulls the site out of a resource URL, or null when it names the bare `/mcp`.
 * Returns undefined when the URL is not one of ours at all.
 *
 * Shape only — whether the endpoint exists is a separate question, asked later
 * and of the database.
 */
export function parseResourceUrl(
  publicBaseUrl: string,
  resource: string,
): { tenantSiteId: string | null } | undefined {
  const root = `${base(publicBaseUrl)}/mcp`;
  if (resource === root) return { tenantSiteId: null };
  if (!resource.startsWith(`${root}/`)) return undefined;

  const rest = resource.slice(root.length + 1);
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(rest)
    ? { tenantSiteId: rest }
    : undefined;
}

/** RFC 9728. Describes /mcp and points at the authorization server. */
export function protectedResourceMetadata(options: MetadataOptions): Record<string, unknown> {
  const root = base(options.publicBaseUrl);

  return {
    resource: mcpResourceUrl(root, options.tenantSiteId),
    // Renkei is its own authorization server. Atlassian is upstream of it,
    // not something the MCP client ever talks to.
    authorization_servers: [root],
    scopes_supported: supportedScopes(options.readOnly),
    bearer_methods_supported: ['header'],
    resource_name: 'Renkei — Jira work item gateway',
  };
}

/** RFC 8414. */
export function authorizationServerMetadata(options: MetadataOptions): Record<string, unknown> {
  const root = base(options.publicBaseUrl);

  return {
    issuer: root,
    authorization_endpoint: `${root}/oauth/authorize`,
    token_endpoint: `${root}/oauth/token`,
    revocation_endpoint: `${root}/oauth/revoke`,
    ...(options.enableDcr ? { registration_endpoint: `${root}/oauth/register` } : {}),
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    // S256 only. Advertising `plain` would let a client choose the downgrade.
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post', 'none'],
    scopes_supported: supportedScopes(options.readOnly),
    // RFC 8707: Renkei reads `resource` and binds it to the session.
    authorization_response_iss_parameter_supported: true,
    service_documentation: 'https://github.com/campfhir/jira-work-items-mcp',
    scope_description: formatScope(supportedScopes(options.readOnly)),
  };
}

/**
 * The 401 challenge. `resource_metadata` is the pointer that starts the whole
 * discovery chain — without it a client has no way to find the authorization
 * server and simply reports a failed connection.
 */
export function bearerChallenge(
  publicBaseUrl: string,
  error?: string,
  description?: string,
  tenantSiteId?: string,
) {
  const parts = [
    'Bearer',
    `realm="renkei"`,
    `resource_metadata="${protectedResourceMetadataUrl(publicBaseUrl, tenantSiteId)}"`,
  ];

  if (error !== undefined) {
    parts.push(`error="${error}"`);
  }
  if (description !== undefined) {
    // Quoted-string: a stray quote would truncate the header.
    parts.push(`error_description="${description.replace(/"/g, "'")}"`);
  }

  return `${parts[0]} ${parts.slice(1).join(', ')}`;
}
