/**
 * The search in the top bar: one box that finds a page or setting in the
 * menu, and moves to it from the keyboard. Chats are searched there too
 * (chat.spec.ts covers what was said in one).
 */

import path from 'node:path';
import { test, expect } from '@playwright/test';
test.use({
  launchOptions: {
    executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    args: ['--no-sandbox'],
  },
});

test('top bar search: Ctrl+K focuses it, a setting is found and opened', async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-light', 'Keyboard and results are a desktop check.');
  await page.goto(`/agents`);
  const search = page.getByRole('searchbox', { name: 'Search Renkei' });
  const results = page.getByRole('listbox', { name: 'Results' });
  await expect(search).toBeVisible();

  await page.locator('body').click();
  await page.keyboard.press('Control+k');
  await expect(search).toBeFocused();

  await search.fill('prefer');
  await expect(results.getByRole('option', { name: 'Preferences' })).toBeVisible();
  // The first result is active; Enter opens it.
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/preferences$/);
  await expect(results).toBeHidden();
  await expect(search).toHaveValue('');

  // Escape clears the text first, then closes the results.
  await search.fill('connectors');
  await expect(results.getByRole('option', { name: 'Connectors' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(search).toHaveValue('');
  await expect(results).toBeHidden();

  // A search that matches nothing says so, and the arrows do not break it.
  await search.fill('zzz no such place');
  await expect(results).toContainText('Nothing matches');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/preferences$/);

  await page.screenshot({
    path: path.join(
      import.meta.dirname,
      '..',
      'test-results',
      'screens',
      testInfo.project.name,
      'omni-search.png'
    ),
  });
});

test('top bar search fits a phone-width header', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-light', 'One viewport resize is enough here.');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/agents`);
  const search = page.getByRole('searchbox', { name: 'Search Renkei' });
  await expect(search).toBeVisible();
  // The box keeps the header's width; nothing spills sideways.
  const box = await search.boundingBox();
  expect(box && box.width).toBeGreaterThan(120);
  const fits = await page.evaluate(
    () => document.documentElement.scrollWidth <= window.innerWidth + 1
  );
  expect(fits).toBe(true);
  // Phone: the font is 16px so focusing it does not zoom the page.
  const fontSize = await search.evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
  expect(fontSize).toBeGreaterThanOrEqual(16);
});
