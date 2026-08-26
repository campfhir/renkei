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
  // Dev only: Next 16 blocks dev resources (chunks, HMR) requested from an
  // origin other than "localhost", and it counts 127.0.0.1 as other — which
  // silently breaks hydration for anything browsing via the IP, Playwright
  // included. Ignored by production builds.
  allowedDevOrigins: ['127.0.0.1'],
  // Workspace packages ship TypeScript source; Next compiles them in-place.
  transpilePackages: [
    '@renkei/db',
    '@renkei/agents',
    '@renkei/agent-llm',
    '@renkei/crypto',
    '@renkei/provider-grants',
    '@renkei/capability-registry',
    '@renkei/connector-config',
    '@renkei/connector-webex',
    '@renkei/connector-microsoft',
    '@renkei/connector-zoom',
    '@renkei/settings',
    '@renkei/tool-outcomes',
    '@renkei/user-prefs',
    '@renkei/gates',
    '@renkei/document-text',
    '@renkei/knowledge',
    '@renkei/connector-fileshares',
  ],
  // The cleaner-script sandbox: left external so its .wasm file resolves
  // from node_modules at runtime instead of being lost in the bundle.
  // Both ship binaries the bundler must not touch: quickjs-emscripten
  // resolves a .wasm at runtime, and esbuild spawns a native child process
  // (it strips types off TypeScript cleaner scripts at save time).
  // The file-share protocol clients stay external too: ssh2 carries
  // optional native bindings its loader probes for at runtime, and both
  // are require()d CJS the bundler has no reason to touch — which is why
  // apps/web declares them directly (the pdfjs rule: a transpiled
  // package's bare specifier resolves from the app at runtime).
  serverExternalPackages: [
    'quickjs-emscripten',
    'esbuild',
    'ssh2-sftp-client',
    '@tryjsky/v9u-smb2',
  ],
  async rewrites() {
    return [
      // RFC 8414 path-insert form for the per-tenant authorization server,
      // with and without the transport segment the client was handed (a
      // client that built this URL from the resource's own address, which
      // includes /{transport}, needs the same match the protected-resource
      // rules below already give it — otherwise it falls through to the
      // catch-all and gets the system-level, tenant-less document instead).
      {
        source: '/.well-known/oauth-authorization-server/api/mcp/:tenantId',
        destination: '/api/mcp/:tenantId/.well-known/oauth-authorization-server',
      },
      {
        source: '/.well-known/oauth-authorization-server/api/mcp/:tenantId/:transport',
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
