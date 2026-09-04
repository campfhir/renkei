/**
 * The app menu as a column beside the page: open by default on a wide
 * screen, hidden by the hamburger and remembered, absent (a drawer) on a
 * phone. Captured on a regular page so the frame is judged without the
 * chat's own chrome in the way.
 */

import path from 'node:path';
import { test, expect } from '@playwright/test';
import { E2E_SLUG } from './seed';

test.use({
  launchOptions: {
    executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    args: ['--no-sandbox'],
  },
});

test('app menu column: open by default, toggles and is remembered', async ({ page }, testInfo) => {
  await page.goto(`/${E2E_SLUG}/agents`);
  const column = page.getByRole('navigation', { name: 'Application' });
  const mobile = testInfo.project.name === 'mobile';
  const shot = (name: string) =>
    page.screenshot({
      path: path.join(import.meta.dirname, '..', 'test-results', 'screens', testInfo.project.name, name),
      fullPage: false,
    });

  if (mobile) {
    // The drawer is parked off-screen by a transform, so it is "visible"
    // in the DOM sense; where it sits is the test.
    const libraries = column.getByRole('link', { name: 'Prompt libraries' });
    await expect(libraries).not.toBeInViewport();
    await page.getByRole('button', { name: 'Open menu' }).click();
    await expect(libraries).toBeInViewport();
    // Let the slide-in finish before the picture.
    await expect.poll(async () => (await column.boundingBox())?.x).toBe(0);
    await shot('nav-drawer.png');
    return;
  }

  await expect(column).toBeVisible();
  await expect(column.getByRole('link', { name: 'Projects' })).toBeVisible();
  await shot('nav-column.png');

  await page.getByRole('button', { name: 'Hide menu' }).click();
  await expect(column).toBeHidden();
  await page.reload();
  await expect(page.getByRole('button', { name: 'Open menu' })).toBeVisible();
  await expect(column).toBeHidden();
  await shot('nav-hidden.png');

  await page.getByRole('button', { name: 'Open menu' }).click();
  await expect(column).toBeVisible();
});
