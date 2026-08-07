import { NextRequest, NextResponse } from 'next/server';
import { getOrigin } from '@/lib/get-origin';

/**
 * OAuth Protected Resource Metadata endpoint (RFC 9728)
 * Published at /.well-known/oauth-protected-resource
 *
 * Advertises which authorization server(s) protect this API, allowing MCP clients
 * to discover the issuer and obtain tokens before accessing the MCP server.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {

  const originResult = await getOrigin(request);
  if (!originResult.ok) {
    return NextResponse.json({ error: 'Config error' }, { status: 500 });
  }
  const baseUrl = originResult.val;

  const metadata = {
    resource: baseUrl,
    // RFC 9728 defines this as an array of issuer identifier strings. It held
    // objects, which a strict client rejects, and advertised a jwks_uri that
    // does not exist and would not be meaningful anyway: the tokens issued here
    // are opaque and validated by database lookup, not signature.
    //
    // MCP clients want the per-tenant document at
    // /api/mcp/{tenantId}/.well-known/oauth-protected-resource; this
    // system-level one covers the platform's own OAuth.
    authorization_servers: [baseUrl],
    bearer_methods_supported: ['header'],
  };

  return NextResponse.json(metadata);
}
