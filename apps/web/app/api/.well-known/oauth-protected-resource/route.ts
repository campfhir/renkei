import { NextResponse } from 'next/server';

/**
 * OAuth Protected Resource Metadata endpoint (RFC 9728) — system level.
 *
 * Renkei has no system-level protected resource: every MCP endpoint is
 * tenant-scoped, and its 401 challenge already names the tenant-scoped
 * protected-resource document via `WWW-Authenticate: resource_metadata=...`.
 * This system-level document used to point at the system-level authorization
 * server, which is non-functional (see the sibling
 * oauth-authorization-server route's docblock) — serving it risked steering
 * a client into that dead end instead of following the challenge it was
 * actually given. 404 pushes every client through the per-tenant document at
 * /api/mcp/{tenantId}/.well-known/oauth-protected-resource, which is correct
 * and already what the 401 response advertises.
 */
export async function GET(): Promise<NextResponse> {
  return NextResponse.json(
    {
      error: 'not_found',
      error_description:
        'This server has no system-level protected resource — every MCP endpoint is ' +
        'tenant-scoped. Follow the resource_metadata field of the WWW-Authenticate ' +
        'challenge returned by the protected MCP endpoint you are calling, or fetch ' +
        '/api/mcp/{tenantId}/.well-known/oauth-protected-resource directly.',
    },
    { status: 404 }
  );
}
