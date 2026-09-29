/**
 * In an installed iOS PWA, target="_blank" opens an in-app browser sheet
 * instead of the default browser. ExternalLink (components/external-link.tsx)
 * hands the URL to Safari through the x-safari- scheme there, and leaves
 * ordinary browsers on plain target="_blank".
 *
 * Read-only: uses the shared seeded session and only clicks a link. The
 * handoff itself is `location.href = 'x-safari-…'`, which a desktop browser
 * cannot follow, so the spec observes it as "React cancelled the anchor's
 * default action" rather than watching a navigation.
 */

import { test, expect, type Page } from '@playwright/test';
import { E2E_SLUG } from './seed';

test.use({
  launchOptions: {
    executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    args: ['--no-sandbox'],
  },
});

async function clickExternalLink(page: Page): Promise<boolean> {
  await page.goto(`/${E2E_SLUG}/admin/connectors/github`);
  const link = page.getByRole('link', { name: 'github.com/settings/apps' });
  await expect(link).toBeVisible();
  await expect(link).toHaveAttribute('target', '_blank');
  await expect(link).toHaveAttribute('rel', /noopener/);
  // React's handler runs at the root; this document-level listener runs
  // after it, so it sees the final defaultPrevented. It then cancels the
  // click itself so the test never opens a popup or leaves the page.
  await page.evaluate(() => {
    const w = window as unknown as { __prevented?: boolean };
    document.addEventListener(
      'click',
      (e) => {
        w.__prevented = e.defaultPrevented;
        e.preventDefault();
      },
      { once: true }
    );
  });
  await link.click();
  return page.evaluate(() => (window as unknown as { __prevented?: boolean }).__prevented === true);
}

test('external link — regular browser keeps plain target=_blank', async ({ page }) => {
  expect(await clickExternalLink(page)).toBe(false);
});

test('external link — installed iOS PWA hands off to the default browser', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(() => {
    Object.defineProperty(window.navigator, 'userAgent', {
      value:
        'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
    });
    Object.defineProperty(window.navigator, 'standalone', { value: true });
  });
  expect(await clickExternalLink(page)).toBe(true);
});
