/**
 * The response headers every page carries (lib/security-headers.ts, applied
 * by next.config.ts's `headers()`), checked against the running server
 * rather than the rule table: a rule that is written but never applied —
 * a `source` pattern that matches nothing, a config export that Next
 * ignores — is invisible to the unit test and exactly what this catches.
 *
 * No browser interaction: the page is fetched through the context's
 * request so the person's session cookie rides along and a real
 * signed-in page answers (an operator's, /admin/access).
 */

import { test, expect } from './fixtures';

test.use({ roles: ['renkei-user', 'renkei-operator'] });

test('a signed-in page carries the security headers', async ({ page, person: _person }) => {
  const response = await page.request.get(`/admin/access`);
  expect(response.ok()).toBe(true);
  const headers = response.headers();

  expect(headers['x-content-type-options']).toBe('nosniff');
  expect(headers['referrer-policy']).toBe('strict-origin-when-cross-origin');
  expect(headers['x-frame-options']).toBe('DENY');
  expect(headers['permissions-policy']).toContain('camera=()');
  expect(headers['permissions-policy']).toContain('microphone=(self)');
  expect(headers['content-security-policy-report-only']).toContain("frame-ancestors 'none'");
  expect(headers['x-powered-by']).toBeUndefined();
  // The server is plain http: no HSTS without an https PUBLIC_BASE_URL.
  expect(headers['strict-transport-security']).toBeUndefined();
});

test('the widget route may be framed by this origin', async ({ page, person: _person }) => {
  // Any URI: the frame headers are decided by the path, not by whether the
  // widget exists, so a 404 answers the question as well as a 200.
  const response = await page.request.get(`/api/chat/widgets?uri=ui://nothing`);
  const headers = response.headers();
  expect(headers['x-frame-options']).toBe('SAMEORIGIN');
  expect(headers['content-security-policy-report-only']).toContain("frame-ancestors 'self'");
  expect(headers['x-content-type-options']).toBe('nosniff');
});
