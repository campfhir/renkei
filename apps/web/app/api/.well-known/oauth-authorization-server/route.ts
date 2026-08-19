import { NextResponse } from 'next/server';

/**
 * OAuth Authorization Server Metadata endpoint (RFC 8414) — system level.
 *
 * This used to advertise /api/oauth/{authorize,token,register}, but that
 * flow could never authenticate an MCP call: the system-level authorize
 * endpoint auto-approved with no real user session (subject: 'system') and
 * the token endpoint issued an access token it never persisted, so nothing
 * built on it could pass resolveAccessToken() — the very first real request
 * 401s. Beyond being a dead end, the unauthenticated authorize endpoint was
 * an unauthenticated issuer of tenant-scoped codes, so both routes have since
 * been removed; this document is a 404 and every client is pushed to the
 * tenant-scoped discovery chain below.
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
