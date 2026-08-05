import type { NextConfig } from 'next';

/**
 * OAuth discovery documents have to live at the origin root.
 *
 * RFC 8414 and RFC 9728 both define well-known URIs relative to the origin, and
 * clients construct those URLs rather than being told where to look. The App
 * Router serves `app/api/.well-known/x/route.ts` at `/api/.well-known/x`, which
 * is not where anyone looks, so every discovery document 404'd and MCP clients
 * could not find the registration endpoint at all.
 *
 * Both spellings are served. For an issuer carrying a path component -- ours is
 * `{base}/api/mcp/{tenantId}` -- RFC 8414 inserts the well-known segment before
 * that path, while the MCP specification also permits appending it. Clients
 * differ over which they try, and serving both costs nothing.
 */
const nextConfig: NextConfig = {
  async rewrites() {
    return [
      // RFC 8414 path-insert form for the per-tenant authorization server.
      {
        source: '/.well-known/oauth-authorization-server/api/mcp/:tenantId',
        destination: '/api/mcp/:tenantId/.well-known/oauth-authorization-server',
      },
      // RFC 9728 path-insert form for the per-tenant protected resource, with
      // and without the transport segment the client was handed.
      {
        source: '/.well-known/oauth-protected-resource/api/mcp/:tenantId',
        destination: '/api/mcp/:tenantId/.well-known/oauth-protected-resource',
      },
      {
        source: '/.well-known/oauth-protected-resource/api/mcp/:tenantId/:transport',
        destination: '/api/mcp/:tenantId/.well-known/oauth-protected-resource',
      },
      // The system-level documents.
      {
        source: '/.well-known/:path*',
        destination: '/api/.well-known/:path*',
      },
    ];
  },
};

export default nextConfig;
