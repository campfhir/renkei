import { NextRequest, NextResponse } from 'next/server';
import { getOrigin } from '@/lib/get-origin';

/**
 * Protected Resource Metadata for this deployment's MCP server (RFC 9728).
 *
 * This is what the `resource_metadata` parameter of the 401 challenge points
 * at. It previously pointed at the authorization server metadata instead, which
 * is a different document: a client following it looked for
 * `authorization_servers`, found none, and gave up before ever reaching the
 * registration endpoint. That is the whole of "couldn't register".
 *
 * `authorization_servers` is an array of issuer identifier strings, not
 * objects. Each entry must match the `issuer` of the corresponding
 * authorization server metadata exactly, or a client will reject it as a
 * mix-up.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const originResult = await getOrigin(request);
  if (!originResult.ok) {
    return NextResponse.json({ error: 'Config error' }, { status: 500 });
  }
  const issuer = `${originResult.val}/api/mcp`;

  return NextResponse.json({
    resource: issuer,
    authorization_servers: [issuer],
    scopes_supported: ['openid', 'profile', 'email'],
    bearer_methods_supported: ['header'],
    resource_documentation: 'https://github.com/campfhir/renkei',
  });
}
