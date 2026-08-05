import { NextRequest, NextResponse } from 'next/server';
import { getConfig } from '@/lib/env';

/**
 * OAuth Authorization Server Metadata endpoint (RFC 8414)
 * Published at /.well-known/oauth-authorization-server
 *
 * Advertises the MCP server's OAuth endpoints and capabilities to clients
 * so they can self-register via Dynamic Client Registration (RFC 7591).
 */
export async function GET(_request: NextRequest): Promise<NextResponse> {
  const configResult = getConfig();
  if (!configResult.ok) {
    return NextResponse.json({ error: 'Config error' }, { status: 500 });
  }
  const config = configResult.val;

  const baseUrl = config.PUBLIC_BASE_URL;
  const dcrEnabled = config.ENABLE_DCR !== 'false';

  const metadata = {
    issuer: baseUrl,
    authorization_endpoint: `${baseUrl}/api/oauth/authorize`,
    token_endpoint: `${baseUrl}/api/oauth/token`,
    ...(dcrEnabled && {
      registration_endpoint: `${baseUrl}/api/oauth/register`,
    }),
    response_types_supported: ['code'],
    response_modes_supported: ['query', 'fragment'],
    grant_types_supported: dcrEnabled
      ? ['authorization_code', 'refresh_token']
      : ['authorization_code'],
    token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post'],
    revocation_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post'],
    introspection_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post'],
    code_challenge_methods_supported: ['S256', 'plain'],
    scopes_supported: ['openid', 'profile', 'email'],
    claims_supported: ['sub', 'name', 'email', 'email_verified'],
    subject_types_supported: ['public'],
    id_token_signing_alg_values_supported: ['RS256'],
    service_documentation: 'https://github.com/campfhir/renkei',
    ui_locales_supported: ['en-US'],
  };

  return NextResponse.json(metadata);
}
