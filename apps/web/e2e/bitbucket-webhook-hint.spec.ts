/**
 * The Bitbucket connector form's webhook instructions: the copy an
 * administrator follows when registering a repository webhook by hand. It
 * must name the `X-Renkei-Webhook-Secret` header as the way to carry the
 * shared secret (lib/bitbucket-webhook.ts), with the URL form mentioned
 * only as the legacy fallback. Read-only against the shared e2e tenant —
 * nothing is saved — on the pinned Chromium.
 */

import { test, expect } from '@playwright/test';
import { E2E_SLUG } from './seed';

test.use({
  launchOptions: {
    executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    args: ['--no-sandbox'],
  },
});

test('the Bitbucket form tells admins to send the webhook secret as a header', async ({ page }) => {
  await page.goto(`/${E2E_SLUG}/admin/connectors/atlassian-bitbucket`);
  const secretField = page.getByLabel(/Webhook secret/);
  await expect(secretField).toBeVisible();
  // The paragraph, not the <code> inside it: the header name is rendered as
  // code, the guidance around it as prose.
  const hint = page.getByText(/so prefer the header/);
  await expect(hint).toBeVisible();
  await expect(hint).toContainText('X-Renkei-Webhook-Secret');
  // The URL form is still described, as the fallback it now is.
  await expect(hint).toContainText('?secret=');

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(hint).toBeVisible();
});
