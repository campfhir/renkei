import { NextResponse } from 'next/server';

/**
 * OAuth Authorization Server Metadata endpoint (RFC 8414) — system level.
 *
 * This used to advertise /api/oauth/{authorize,token,register}, but that
 * flow cannot actually authenticate an MCP call: /api/oauth/authorize
 * auto-approves with no real user session (subject: 'system'), and
 * /api/oauth/token issues an access token it never persists, so nothing
 * built on it can pass resolveAccessToken() — the very first real request
 * 401s. A client that completes registration and the authorize/token dance
 * against this document believes it succeeded and only discovers otherwise
 * on its first authenticated call, which is a worse failure than a 404 here.
 *
 * Renkei's authorization server is per tenant. The protected MCP endpoint's
 * 401 response already names the right one via
 * `WWW-Authenticate: resource_metadata=...` (RFC 9728) — that document's
 * `authorization_servers` entry is the tenant-scoped issuer, whose metadata
 * lives at /api/mcp/{tenantId}/.well-known/oauth-authorization-server (also
 * reachable via the RFC 8414 path-insert form at
 * /.well-known/oauth-authorization-server/api/mcp/{tenantId}, see
 * next.config.ts).
 */
export async function GET(): Promise<NextResponse> {
  return NextResponse.json(
    {
      error: 'not_found',
      error_description:
        'This server has no system-level authorization server — every MCP endpoint is ' +
        'tenant-scoped. Discover the right one from the resource_metadata field of the ' +
        'WWW-Authenticate challenge your MCP endpoint returned, or fetch ' +
        '/api/mcp/{tenantId}/.well-known/oauth-authorization-server directly.',
    },
    { status: 404 }
  );
}
