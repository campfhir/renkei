/**
 * The About page's dated release headings fit a phone-width screen.
 *
 * That every release is headed by its calendar date (never a fallback such
 * as "Unreleased"), and how a date is written, is lib/changelog.test.ts on
 * `releaseDate` and the CHANGELOG itself; only the layout is checked here.
 */

import { test, expect } from './fixtures';

test('about page — dated release headings fit a phone-width screen', async ({
  page,
  person: _person,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/about`);
  await expect(page.getByRole('heading', { name: /changed/ })).toBeVisible();

  const firstHeading = page.locator('section h3').first();
  await expect(firstHeading).toHaveText(/^\d{1,2} [A-Z][a-z]+ \d{4}$/);
  const box = await firstHeading.boundingBox();
  expect(box).not.toBeNull();
  expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(390);

  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth
  );
  expect(overflow).toBe(false);
});
