/**
 * Every release on the About page is headed by its calendar date. Work that
 * is on main carries the day it landed (changelog.ts makes the date required),
 * so no section falls back to a heading such as "Unreleased".
 */

import { test, expect } from './fixtures';

const DATED_HEADING = /^\d{1,2} [A-Z][a-z]+ \d{4}$/;

test('about page — every changelog release is headed by a date', async ({
  page,
  person: _person,
}) => {
  await page.goto(`/about`);
  await expect(page.getByRole('heading', { name: /changed/ })).toBeVisible();

  const sectionHeadings = page.locator('section h3');
  const count = await sectionHeadings.count();
  expect(count).toBeGreaterThan(0);

  for (let i = 0; i < count; i++) {
    await expect(sectionHeadings.nth(i)).toHaveText(DATED_HEADING);
  }
  await expect(page.getByText('Unreleased', { exact: true })).toHaveCount(0);
});

test('about page — dated release headings fit a phone-width screen', async ({
  page,
  person: _person,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/about`);
  await expect(page.getByRole('heading', { name: /changed/ })).toBeVisible();

  const firstHeading = page.locator('section h3').first();
  await expect(firstHeading).toBeVisible();
  const box = await firstHeading.boundingBox();
  expect(box).not.toBeNull();
  expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(390);

  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth
  );
  expect(overflow).toBe(false);
});
