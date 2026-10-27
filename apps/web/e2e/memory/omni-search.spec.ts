/**
 * The search in the top bar: one box that finds a page or setting in the
 * menu, and moves to it from the keyboard. Chats are searched there too
 * (chat.spec.ts covers what was said in one).
 */

import path from 'node:path';
import { test, expect } from './fixtures';

test('top bar search: Ctrl+K focuses it, a setting is found and opened', async ({
  page,
  person: _person,
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
  await expect(results.getByRole('option', { name: 'Preferences', exact: true })).toBeVisible();
  await results.getByRole('option', { name: 'Preferences', exact: true }).click();
  await expect(page).toHaveURL(/\/preferences$/);
  await expect(results).toBeHidden();
  await expect(search).toHaveValue('');

  // Escape clears the text first, then closes the results.
  await search.fill('connectors');
  await expect(results.getByRole('option', { name: 'Connectors', exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(search).toHaveValue('');
  await expect(results).toBeHidden();

  // A search that matches nothing says so, and the arrows do not break it.
  await search.fill('zzz no such place');
  await expect(results).toContainText('Nothing matches');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowUp');
  await expect(results).toContainText('Nothing matches');

  await page.screenshot({
    path: path.join(
      import.meta.dirname,
      '..',
      '..',
      'test-results',
      'memory',
      'screens',
      testInfo.project.name,
      'omni-search.png'
    ),
  });
});

test('on a phone the top bar folds search into a magnifier that opens a full field', async ({
  page,
  person: _person,
}, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-light', 'One viewport resize is enough here.');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/agents`);
  const search = page.getByRole('searchbox', { name: 'Search Renkei' });
  const results = page.getByRole('listbox', { name: 'Results' });

  // The logo and name are gone; the field is folded into the magnifier.
  await expect(page.getByRole('link', { name: 'Renkei' })).toBeHidden();
  await expect(search).toBeHidden();
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await expect(search).toBeFocused();

  // Open, the field takes the space the logo and magnifier left.
  const box = await search.boundingBox();
  expect(box?.width ?? 0, `field width ${box?.width}`).toBeGreaterThan(180);
  const fits = await page.evaluate(
    () => document.documentElement.scrollWidth <= window.innerWidth + 1
  );
  expect(fits).toBe(true);
  // Phone: the font is 16px so focusing it does not zoom the page.
  const fontSize = await search.evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
  expect(fontSize).toBeGreaterThanOrEqual(16);

  await search.fill('prefer');
  await results.getByRole('option', { name: 'Preferences', exact: true }).click();
  await expect(page).toHaveURL(/\/preferences$/);
  // Back on the new page the field folds away again.
  await expect(search).toBeHidden();
});
