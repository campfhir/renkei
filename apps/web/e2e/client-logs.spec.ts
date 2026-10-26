/**
 * An uncaught error in the browser is reported to the server with the page it
 * happened on and the browser that hit it. The server answers 204 (the person
 * never sees the report), and writes the record through the logger.
 */

import { test, expect } from '@playwright/test';

test.use({
  launchOptions: {
    executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    args: ['--no-sandbox'],
  },
});

test('an uncaught browser error is reported with its page and browser', async ({ page }) => {
  await page.goto('/');
  // The reporter listens once the page has hydrated; an error before that is not reported.
  await page.waitForLoadState('networkidle');
  const report = page.waitForRequest((request) => request.url().endsWith('/api/client-logs'));
  const answer = page.waitForResponse((response) => response.url().endsWith('/api/client-logs'));
  await page.evaluate(() => {
    setTimeout(() => {
      throw new Error('e2e uncaught browser error');
    });
  });
  const sent = await report;
  const body = sent.postDataJSON() as Record<string, unknown>;
  expect(body.message).toBe('e2e uncaught browser error');
  expect(body.page).toBe('/');
  expect(String(body.browserAgent)).toContain('Chrome');
  expect(String(body.stack)).toContain('Error');
  expect((await answer).status()).toBe(204);
});
