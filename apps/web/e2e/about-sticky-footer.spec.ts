/**
 * The About page's changelog is long enough to require scrolling on any
 * screen. The version footer must stay on screen without the visitor
 * scrolling the page at all, and must not move once they do scroll (the
 * changelog itself is what scrolls, in its own region).
 */

import { test, expect } from '@playwright/test';
import { E2E_SLUG } from './seed';

test('about page — version footer is visible without scrolling', async ({ page }) => {
  await page.goto(`/${E2E_SLUG}/about`);
  await expect(page.getByRole('heading', { name: /changed/ })).toBeVisible();

  const footer = page.locator('footer', { hasText: 'Build' });
  await expect(footer).toBeVisible();

  const viewport = page.viewportSize();
  expect(viewport).not.toBeNull();
  const box = await footer.boundingBox();
  expect(box).not.toBeNull();

  // No scrolling has happened yet — the footer must already sit fully
  // inside the viewport's vertical bounds.
  expect(box!.y).toBeGreaterThanOrEqual(0);
  expect(box!.y + box!.height).toBeLessThanOrEqual(viewport!.height + 1);

  // The document itself should not have grown taller than one viewport —
  // otherwise the "no scrolling needed" guarantee is accidental rather
  // than structural.
  const scrollHeight = await page.evaluate(() => document.documentElement.scrollHeight);
  expect(scrollHeight).toBeLessThanOrEqual(viewport!.height + 1);

  // Scrolling the page itself (not the internal changelog list) must not
  // move the footer — there is nothing left for the outer page to scroll.
  await page.mouse.wheel(0, 2000);
  const boxAfterScroll = await footer.boundingBox();
  expect(boxAfterScroll).toEqual(box);
});
