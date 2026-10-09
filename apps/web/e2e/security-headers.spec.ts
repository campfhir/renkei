/**
 * The response headers every page carries (lib/security-headers.ts, applied
 * by next.config.ts's `headers()`), checked against the running dev server
 * rather than the rule table: a rule that is written but never applied —
 * a `source` pattern that matches nothing, a config export that Next
 * ignores — is invisible to the unit test and exactly what this catches.
 *
 * No browser interaction, so it runs on the pinned Chromium alone; the
 * page is fetched through the context's request so the seeded session
 * cookie rides along and a real signed-in page answers.
 */

import { test, expect } from '@playwright/test';
import { E2E_SLUG, E2E_TENANT_ID } from './seed';

test.use({
  launchOptions: {
    executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    args: ['--no-sandbox'],
  },
});

test('a signed-in page carries the security headers', async ({ page }) => {
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
  // The dev server is plain http: no HSTS without an https PUBLIC_BASE_URL.
  expect(headers['strict-transport-security']).toBeUndefined();
});

test('the widget route may be framed by this origin', async ({ page }) => {
  // Any URI: the frame headers are decided by the path, not by whether the
  // widget exists, so a 404 answers the question as well as a 200.
  const response = await page.request.get(
    `/api/chat/widgets?uri=ui://nothing`
  );
  const headers = response.headers();
  expect(headers['x-frame-options']).toBe('SAMEORIGIN');
  expect(headers['content-security-policy-report-only']).toContain("frame-ancestors 'self'");
  expect(headers['x-content-type-options']).toBe('nosniff');
});
