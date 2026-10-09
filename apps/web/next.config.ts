import type { NextConfig } from 'next';
import { securityHeaderRules } from './lib/security-headers';

/**
 * OAuth discovery documents have to live at the origin root.
 *
 * RFC 8414 and RFC 9728 both define well-known URIs relative to the origin, and
 * clients construct those URLs rather than being told where to look. The App
 * Router serves `app/api/mcp/.well-known/x/route.ts` at `/api/mcp/.well-known/x`,
 * which is not where anyone looks, so the rewrites below serve every spelling a
 * client may try: the origin-root form, and the path-insert form for an issuer
 * that carries a path component (`{base}/api/mcp`), with and without the
 * transport segment. Serving them all costs nothing.
 */
const nextConfig: NextConfig = {
  // No `X-Powered-By: Next.js`: it names the framework to every client for
  // nothing in return.
  poweredByHeader: false,
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
    '@renkei/connector-onbase',
    '@renkei/mcp-client',
    '@renkei/blob-store',
    '@renkei/voice',
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
  // The chat's document renderers stay external as well: pdfkit reads
  // its font metrics off disk at runtime, and the office writers are
  // CJS with their own zip machinery — nothing a server bundle improves.
  serverExternalPackages: [
    'quickjs-emscripten',
    'esbuild',
    'ssh2-sftp-client',
    '@tryjsky/v9u-smb2',
    'pdfkit',
    'exceljs',
    'pptxgenjs',
    'docx',
  ],
  // Response security headers (lib/security-headers.ts): nosniff, referrer
  // and permissions policies, frame denial except on the routes the chat
  // frames, a report-only CSP, and HSTS when PUBLIC_BASE_URL is https.
  async headers() {
    return securityHeaderRules({
      nodeEnv: process.env.NODE_ENV,
      publicBaseUrl: process.env.PUBLIC_BASE_URL,
    });
  },
  async rewrites() {
    const documents = ['oauth-authorization-server', 'oauth-protected-resource'];
    return documents.flatMap((document) => {
      const destination = `/api/mcp/.well-known/${document}`;
      return [
        // The origin-root form both RFCs define.
        { source: `/.well-known/${document}`, destination },
        // RFC 8414 path-insert form for an issuer carrying a path (ours is
        // `{base}/api/mcp`), with and without the transport segment a client
        // was handed as the resource address.
        { source: `/.well-known/${document}/api/mcp`, destination },
        { source: `/.well-known/${document}/api/mcp/:transport`, destination },
      ];
    });
  },
};

export default nextConfig;
