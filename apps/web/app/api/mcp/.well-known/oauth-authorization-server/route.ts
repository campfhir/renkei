import { NextRequest, NextResponse } from 'next/server';
import { logger } from '@/lib/logger';
import { getOrgSettings, DEFAULT_ORG_SETTINGS } from '@renkei/settings';
import { getOrigin } from '@/lib/get-origin';
import { CODE_CHALLENGE_METHODS } from '@/lib/oauth-pkce';

/**
 * OAuth Authorization Server Metadata (RFC 8414) for this deployment's MCP
 * server. Served at the origin root and in the path-insert form by the
 * rewrites in next.config.ts; the issuer carries the `/api/mcp` path so it
 * matches the `authorization_servers` entry of the protected-resource
 * document exactly.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const originResult = await getOrigin(request);
    if (!originResult.ok) {
      return NextResponse.json({ error: 'Config error' }, { status: 500 });
    }
    const issuer = `${originResult.val}/api/mcp`;
    const settingsResult = await getOrgSettings();
    const dcrEnabled = (settingsResult.ok ? settingsResult.val : DEFAULT_ORG_SETTINGS).enableDcr;

    const metadata = {
      issuer,
      authorization_endpoint: `${issuer}/oauth/authorize`,
      token_endpoint: `${issuer}/oauth/token`,
      ...(dcrEnabled && {
        registration_endpoint: `${issuer}/oauth/register`,
      }),
      response_types_supported: ['code'],
      response_modes_supported: ['query', 'fragment'],
      grant_types_supported: dcrEnabled
        ? ['authorization_code', 'refresh_token']
        : ['authorization_code'],
      token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post'],
      revocation_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post'],
      introspection_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post'],
      // PKCE is required of every client, and only the S256 transform is
      // accepted (lib/oauth-pkce.ts); `plain` sends the verifier itself.
      code_challenge_methods_supported: [...CODE_CHALLENGE_METHODS],
      scopes_supported: ['openid', 'profile', 'email'],
      claims_supported: ['sub', 'name', 'email', 'email_verified'],
      subject_types_supported: ['public'],
      id_token_signing_alg_values_supported: ['RS256'],
      service_documentation: 'https://github.com/campfhir/renkei',
      ui_locales_supported: ['en-US'],
    };

    return NextResponse.json(metadata);
  } catch (error) {
    logger.error('Error: {detail}', {
      component: 'auth/oauth-metadata',
      detail: error instanceof Error ? error.message : String(error),
    });
    return NextResponse.json({ error: 'server_error' }, { status: 500 });
  }
}
