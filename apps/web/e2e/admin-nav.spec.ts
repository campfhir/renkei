/**
 * The Organization console at a desktop's width and a phone's: its areas
 * behind a sidebar inside the main area on a wide screen, and on a phone
 * the area list as the /admin page, each area opening with a link back.
 * Someone without the operator role gets no sidebar at all.
 *
 * Which area a path is in, the groups, and the parts of Settings are
 * admin/admin-nav.model.test.ts's.
 */

import path from 'node:path';
import type { Page, TestInfo } from '@playwright/test';
import { test, expect } from './fixtures';

async function shot(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  await page.screenshot({
    path: path.join(
      import.meta.dirname,
      '..',
      'test-results',
      'screens',
      testInfo.project.name,
      name
    ),
    fullPage: true,
  });
}

const overflows = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);

test.describe('an operator', () => {
  test.use({ roles: ['renkei-user', 'renkei-operator'] });

  test('moves between areas from the sidebar on a wide screen', async ({
    page,
    person: _person,
  }, testInfo) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const main = page.getByRole('main');
    const sidebar = main.getByRole('navigation', { name: 'Organization areas' });

    await page.goto(`/admin`);
    await expect(main.getByRole('heading', { level: 1, name: 'Organization' })).toBeVisible();
    await expect(sidebar.getByRole('link', { name: 'Overview' })).toHaveAttribute(
      'aria-current',
      'page'
    );
    await shot(page, testInfo, 'admin-desktop-overview.png');

    // An area opens beside the sidebar, and is the one marked.
    await sidebar.getByRole('link', { name: 'Holiday calendars' }).click();
    await expect(page).toHaveURL(/\/admin\/calendars$/);
    await expect(sidebar.getByRole('link', { name: 'Holiday calendars' })).toHaveAttribute(
      'aria-current',
      'page'
    );
    await expect(sidebar.getByRole('link', { name: 'Overview' })).not.toHaveAttribute(
      'aria-current',
      'page'
    );

    // Settings lists its parts under it, a link to each heading on the page.
    // Settings reads the most of any area; give its page the navigation's own time.
    await sidebar.getByRole('link', { name: 'Settings', exact: true }).click();
    await page.waitForURL(/\/admin\/settings$/);
    await expect(main.getByRole('heading', { level: 1, name: 'Settings' })).toBeVisible();
    const part = sidebar.getByRole('link', { name: 'Request limits' });
    await expect(part).toHaveAttribute('href', '#settings-request-limits');
    await part.click();
    await expect(main.getByRole('heading', { level: 2, name: 'Request limits' })).toBeInViewport();
    expect(await overflows(page)).toBe(false);
    await shot(page, testInfo, 'admin-desktop-settings.png');
  });

  test('opens an area from the list on a phone, with a way back', async ({
    page,
    person: _person,
  }, testInfo) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const main = page.getByRole('main');
    const sidebar = main.getByRole('navigation', { name: 'Organization areas' });

    await page.goto(`/admin`);
    await expect(sidebar).toBeHidden();
    expect(await overflows(page)).toBe(false);
    await shot(page, testInfo, 'admin-mobile-overview.png');

    await main.getByRole('link', { name: /^Holiday calendars/ }).click();
    await expect(page).toHaveURL(/\/admin\/calendars$/);
    expect(await overflows(page)).toBe(false);
    await shot(page, testInfo, 'admin-mobile-area.png');

    await main.getByRole('link', { name: 'Organization', exact: true }).click();
    await expect(page).toHaveURL(/\/admin$/);
    await expect(main.getByRole('heading', { level: 1, name: 'Organization' })).toBeVisible();
  });
});

test('someone who is not an operator gets no sidebar', async ({ page, person: _person }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const main = page.getByRole('main');
  await page.goto(`/admin`);
  await expect(main.getByRole('heading', { name: 'Operator access required' })).toBeVisible();
  await expect(main.getByRole('navigation', { name: 'Organization areas' })).toHaveCount(0);
});
