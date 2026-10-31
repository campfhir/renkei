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
  const enforcedRule = production[1];

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

  it('enforces only the directives that need no nonce, and reports the rest', () => {
    expect(everywhere['Content-Security-Policy']).toBeUndefined();
    expect(headerMap(enforcedRule.headers)['Content-Security-Policy']).toBe(
      "object-src 'none'; base-uri 'self'; frame-ancestors 'none'"
    );
    expect(everywhere['Reporting-Endpoints']).toBe('csp="/api/csp-report"');
    expect(everywhere['Content-Security-Policy-Report-Only']).toContain(
      'report-uri /api/csp-report'
    );
    expect(everywhere['Content-Security-Policy-Report-Only']).toContain('report-to csp');
  });

  it('reports a CSP with no third-party script origins', () => {
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
    const framed = production.slice(2);
    expect(framed.map((rule) => rule.source)).toEqual(FRAMED_ROUTES);
    expect(FRAMED_ROUTES).toContain('/api/chat/widgets');
    expect(FRAMED_ROUTES).toContain('/api/chat/chats/:chatId/mockups/:toolUseId');
    for (const rule of framed) {
      const headers = headerMap(rule.headers);
      expect(headers['X-Frame-Options']).toBe('SAMEORIGIN');
      expect(headers['Content-Security-Policy-Report-Only']).toContain("frame-ancestors 'self'");
      // The documents set a CSP of their own (the mockup route's carries its
      // `sandbox`): a header from the config would replace it.
      expect(headers['Content-Security-Policy']).toBeUndefined();
    }
  });

  it('puts the enforced directives on every route but the framed ones', () => {
    // `/:path((?!a|b).*)`: the lookahead is the whole of the rule's reach.
    const lookahead = enforcedRule.source.match(/^\/:path\(\(\?!(.*)\)\.\*\)$/)?.[1];
    expect(lookahead).toBeDefined();
    const matches = new RegExp(`^/(?!${lookahead}).*$`);
    for (const path of [
      '/',
      '/chat/abc',
      '/api/chat/chats/123',
      '/api/health',
      '/api/chat/widgetsx',
    ]) {
      expect(matches.test(path)).toBe(true);
    }
    for (const path of [
      '/api/chat/widgets',
      '/api/chat/widgets/x',
      '/api/chat/chats/123/mockups/t1',
    ]) {
      expect(matches.test(path)).toBe(false);
    }
  });
});
