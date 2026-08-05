import { NextRequest, NextResponse } from 'next/server';
import { getConfig } from '@/lib/env';

/**
 * OAuth Protected Resource Metadata endpoint (RFC 9728)
 * Published at /.well-known/oauth-protected-resource
 *
 * Advertises which authorization server(s) protect this API, allowing MCP clients
 * to discover the issuer and obtain tokens before accessing the MCP server.
 */
export async function GET(_request: NextRequest): Promise<NextResponse> {
  const configResult = getConfig();
  if (!configResult.ok) {
    return NextResponse.json({ error: 'Config error' }, { status: 500 });
  }
  const config = configResult.val;

  const baseUrl = config.PUBLIC_BASE_URL;

  const metadata = {
    // This server is its own authorization server
    authorization_servers: [
      {
        issuer: baseUrl,
        jwks_uri: `${baseUrl}/api/.well-known/jwks.json`,
      },
    ],
  };

  return NextResponse.json(metadata);
}
