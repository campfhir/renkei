/**
 * The response headers every page carries. The rule table is read back
 * under different environments, and then — what security-headers.spec.ts
 * checked against a running server before — through next.config.ts the
 * way Next applies it: the config's own `headers()` and `poweredByHeader`,
 * each rule's `source` matched by Next's path matcher, later rules
 * overriding earlier ones for the same key. A rule that is written but
 * never applied (a source that matches nothing, a config that forgets to
 * return the rules) fails here.
 */

import { getPathMatch } from 'next/dist/shared/lib/router/utils/path-match';
import nextConfig from '../next.config';
import { FRAMED_ROUTES, securityHeaderRules, servesHttps } from './security-headers';

function headerMap(headers: Array<{ key: string; value: string }>): Record<string, string> {
  return Object.fromEntries(headers.map(({ key, value }) => [key, value]));
}

describe('security header rules', () => {
  const production = securityHeaderRules({
    nodeEnv: 'production',
    publicBaseUrl: 'https://renkei.example.com',
  });
  const everywhere = headerMap(production[0].headers);

  it('applies the baseline to every path', () => {
    expect(production[0].source).toBe('/:path*');
    expect(everywhere['X-Content-Type-Options']).toBe('nosniff');
    expect(everywhere['Referrer-Policy']).toBe('strict-origin-when-cross-origin');
    expect(everywhere['X-Frame-Options']).toBe('DENY');
  });

  it('denies camera, geolocation and payment but lets the page use the microphone', () => {
    const policy = everywhere['Permissions-Policy'];
    expect(policy).toContain('camera=()');
    expect(policy).toContain('geolocation=()');
    expect(policy).toContain('payment=()');
    expect(policy).toContain('microphone=(self)');
  });

  it('reports a CSP (not yet enforcing) with no third-party script origins', () => {
    expect(everywhere['Content-Security-Policy']).toBeUndefined();
    const csp = everywhere['Content-Security-Policy-Report-Only'];
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toMatch(/script-src 'self' 'unsafe-inline'(;|$)/);
    expect(csp).not.toContain('unsafe-eval');
    expect(csp).not.toMatch(/script-src[^;]*https:/);
  });

  it("allows eval in development only (React's error-stack reconstruction)", () => {
    const dev = securityHeaderRules({ nodeEnv: 'development', publicBaseUrl: undefined });
    expect(headerMap(dev[0].headers)['Content-Security-Policy-Report-Only']).toContain(
      "'unsafe-eval'"
    );
  });

  it('sends HSTS only when the deployment declares itself https', () => {
    expect(everywhere['Strict-Transport-Security']).toBe('max-age=31536000; includeSubDomains');
    const plain = securityHeaderRules({ nodeEnv: 'production', publicBaseUrl: 'http://localhost' });
    expect(headerMap(plain[0].headers)['Strict-Transport-Security']).toBeUndefined();
    const unset = securityHeaderRules({ nodeEnv: 'production', publicBaseUrl: undefined });
    expect(headerMap(unset[0].headers)['Strict-Transport-Security']).toBeUndefined();
  });

  it.each([
    ['https://renkei.example.com', true],
    ['HTTPS://renkei.example.com/', true],
    ['http://renkei.example.com', false],
    [undefined, false],
    ['', false],
  ])('servesHttps(%p) is %p', (url, expected) => {
    expect(servesHttps(url)).toBe(expected);
  });

  it('lets the framed routes be framed by this origin and nothing else', () => {
    const framed = production.slice(1);
    expect(framed.map((rule) => rule.source)).toEqual(FRAMED_ROUTES);
    expect(FRAMED_ROUTES).toContain('/api/chat/widgets');
    expect(FRAMED_ROUTES).toContain('/api/chat/chats/:chatId/mockups/:toolUseId');
    for (const rule of framed) {
      const headers = headerMap(rule.headers);
      expect(headers['X-Frame-Options']).toBe('SAMEORIGIN');
      expect(headers['Content-Security-Policy-Report-Only']).toContain("frame-ancestors 'self'");
      // The mockup route sets its own enforcing CSP; nothing here competes with it.
      expect(headers['Content-Security-Policy']).toBeUndefined();
    }
  });
});

describe('next.config.ts applies the rules', () => {
  /** The headers Next would send for `path`: every matching rule, in order, last key wins. */
  async function headersFor(path: string): Promise<Record<string, string>> {
    const rules = (await nextConfig.headers?.()) ?? [];
    const sent: Record<string, string> = {};
    for (const rule of rules) {
      const match = getPathMatch(rule.source, { removeUnnamedParams: true, strict: true });
      if (match(path) === false) continue;
      for (const { key, value } of rule.headers) sent[key.toLowerCase()] = value;
    }
    return sent;
  }

  const savedBaseUrl = process.env.PUBLIC_BASE_URL;
  afterEach(() => {
    if (savedBaseUrl === undefined) delete process.env.PUBLIC_BASE_URL;
    else process.env.PUBLIC_BASE_URL = savedBaseUrl;
  });

  it('does not name the framework in X-Powered-By', () => {
    expect(nextConfig.poweredByHeader).toBe(false);
  });

  it('a signed-in page carries the security headers, and no HSTS on plain http', async () => {
    process.env.PUBLIC_BASE_URL = 'http://127.0.0.1:3100';
    const headers = await headersFor('/admin/access');
    expect(headers['x-content-type-options']).toBe('nosniff');
    expect(headers['referrer-policy']).toBe('strict-origin-when-cross-origin');
    expect(headers['x-frame-options']).toBe('DENY');
    expect(headers['permissions-policy']).toContain('camera=()');
    expect(headers['permissions-policy']).toContain('microphone=(self)');
    expect(headers['content-security-policy-report-only']).toContain("frame-ancestors 'none'");
    expect(headers['strict-transport-security']).toBeUndefined();
  });

  it('an https deployment adds HSTS to every page', async () => {
    process.env.PUBLIC_BASE_URL = 'https://renkei.example.com';
    expect((await headersFor('/chat'))['strict-transport-security']).toBe(
      'max-age=31536000; includeSubDomains'
    );
  });

  it.each(['/api/chat/widgets', '/api/chat/chats/chat-1/mockups/toolu_1'])(
    '%s may be framed by this origin, and keeps the baseline',
    async (path) => {
      const headers = await headersFor(path);
      expect(headers['x-frame-options']).toBe('SAMEORIGIN');
      expect(headers['content-security-policy-report-only']).toContain("frame-ancestors 'self'");
      expect(headers['x-content-type-options']).toBe('nosniff');
    }
  );

  it('a route next to a framed one is still denied', async () => {
    const headers = await headersFor('/api/chat/chats/chat-1');
    expect(headers['x-frame-options']).toBe('DENY');
  });
});
