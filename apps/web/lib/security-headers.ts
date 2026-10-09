/**
 * Response security headers for every route, applied through
 * `next.config.ts`'s `headers()` so they ride on static assets and pages
 * alike — the proxy would only reach the paths its matcher names, and a
 * route handler would have to remember to set them.
 *
 * Plain functions over data rather than literals in the config so a unit
 * test can read the rules back under different environments (HSTS is only
 * right when the deployment is https) and a reviewer can find the whole
 * policy in one place.
 *
 * Content-Security-Policy is REPORT-ONLY for now. The App Router hydrates
 * through inline `<script>` tags and Tailwind/next-font emit inline styles,
 * so an enforcing policy needs per-request nonces (dynamic rendering of
 * every page, through the proxy) before it could drop `'unsafe-inline'`;
 * reporting first says what the real surface is before anything is blocked.
 * What the policy encodes about THIS app:
 *
 * - No third-party script or style origin: Monaco is bundled and spawns its
 *   workers from same-origin blobs (lib/monaco/setup.ts), fonts come
 *   self-hosted through next/font. `script-src` and `style-src` are self
 *   plus inline, nothing else.
 * - `connect-src https:` beyond self: the create-organization page fetches
 *   the identity provider's discovery document from the browser to show the
 *   issuer before saving (app/create-organization/page.tsx).
 * - `img-src https:`: connector avatars (Atlassian, Microsoft) are linked by
 *   provider URL.
 * - `frame-src 'self' blob:`: widget cards and mockups are same-origin
 *   iframes; artifacts render into srcdoc frames.
 * - `frame-ancestors 'none'` and `X-Frame-Options: DENY` everywhere EXCEPT
 *   the routes that exist to be framed (`FRAMED_ROUTES`): the MCP widget
 *   HTML and chat mockups are loaded into same-origin iframes by the chat,
 *   so those answer SAMEORIGIN instead, and the mockup route's own CSP
 *   (lib/mockups/document.ts) stays authoritative — the enforcing header
 *   it sets is not touched here.
 */

export interface HeaderRule {
  source: string;
  headers: Array<{ key: string; value: string }>;
}

/**
 * Routes that are intentionally loaded in an iframe by this app's own
 * pages. Each gets `frame-ancestors 'self'` / `X-Frame-Options: SAMEORIGIN`
 * in place of the global deny.
 */
export const FRAMED_ROUTES = [
  // The MCP widget card's HTML (app/[slug]/chat/_components/widget-card.tsx,
  // app/[slug]/approval-widget-card.tsx).
  '/api/tenant/:tenantId/chat/widgets',
  // A chat mockup's document (app/[slug]/chat/_components/mockup-viewer.tsx).
  '/api/tenant/:tenantId/chat/chats/:chatId/mockups/:toolUseId',
];

const PERMISSIONS_POLICY = [
  'camera=()',
  'geolocation=()',
  'payment=()',
  // The chat's voice feature records from the page itself.
  'microphone=(self)',
].join(', ');

export function contentSecurityPolicy(options: {
  isDevelopment: boolean;
  frameAncestors: "'none'" | "'self'";
}): string {
  const directives = [
    "default-src 'self'",
    // 'unsafe-eval' in development only: React reconstructs server stack
    // traces in the browser with eval; production builds do not.
    `script-src 'self' 'unsafe-inline'${options.isDevelopment ? " 'unsafe-eval'" : ''}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https:",
    "font-src 'self' data:",
    "connect-src 'self' https:",
    "media-src 'self' blob: data:",
    "worker-src 'self' blob:",
    "frame-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    `frame-ancestors ${options.frameAncestors}`,
  ];
  return directives.join('; ');
}

export interface SecurityHeaderEnv {
  /** `process.env.NODE_ENV`. */
  nodeEnv: string | undefined;
  /** `process.env.PUBLIC_BASE_URL` — the deployment's declared address. */
  publicBaseUrl: string | undefined;
}

/** HSTS belongs only to a deployment that declares itself https. */
export function servesHttps(publicBaseUrl: string | undefined): boolean {
  return typeof publicBaseUrl === 'string' && /^https:\/\//i.test(publicBaseUrl.trim());
}

export function securityHeaderRules(env: SecurityHeaderEnv): HeaderRule[] {
  const isDevelopment = env.nodeEnv === 'development';
  const common = [
    { key: 'X-Content-Type-Options', value: 'nosniff' },
    { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
    { key: 'Permissions-Policy', value: PERMISSIONS_POLICY },
    ...(servesHttps(env.publicBaseUrl)
      ? [{ key: 'Strict-Transport-Security', value: 'max-age=31536000; includeSubDomains' }]
      : []),
  ];
  const everywhere: HeaderRule = {
    source: '/:path*',
    headers: [
      ...common,
      { key: 'X-Frame-Options', value: 'DENY' },
      {
        key: 'Content-Security-Policy-Report-Only',
        value: contentSecurityPolicy({ isDevelopment, frameAncestors: "'none'" }),
      },
    ],
  };
  // Later rules override earlier ones for the same header key, so these
  // only need to restate what differs for a framed route.
  const framed: HeaderRule[] = FRAMED_ROUTES.map((source) => ({
    source,
    headers: [
      { key: 'X-Frame-Options', value: 'SAMEORIGIN' },
      {
        key: 'Content-Security-Policy-Report-Only',
        value: contentSecurityPolicy({ isDevelopment, frameAncestors: "'self'" }),
      },
    ],
  }));
  return [everywhere, ...framed];
}
