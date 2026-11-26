/**
 * The Organization console at a desktop's width and a phone's: its areas
 * behind a sidebar inside the main area on a wide screen, and on a phone
 * the area list as the /admin page, each area opening with a link back.
 * Someone without the operator role gets no sidebar at all.
 *
 * Which area a path is in, the groups, and Settings' own groups are
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

    // Settings is its groups: listed on its page, and under it in the sidebar.
    await sidebar.getByRole('link', { name: 'Settings', exact: true }).click();
    await page.waitForURL(/\/admin\/settings$/);
    await expect(main.getByRole('heading', { level: 1, name: 'Settings' })).toBeVisible();
    const groups = main.getByRole('navigation', { name: 'Settings groups' });
    await expect(groups.getByRole('link')).toHaveCount(6);
    await shot(page, testInfo, 'admin-desktop-settings.png');

    // A group is a page of its own, holding its parts of the form and nothing else's.
    await sidebar.getByRole('link', { name: 'Access & limits' }).click();
    await page.waitForURL(/\/admin\/settings\/access$/);
    await expect(sidebar.getByRole('link', { name: 'Access & limits' })).toHaveAttribute(
      'aria-current',
      'page'
    );
    await expect(main.getByRole('heading', { level: 2, name: 'Request limits' })).toBeVisible();
    await expect(main.getByRole('heading', { level: 2, name: 'Sandbox' })).toHaveCount(0);
    await expect(main.getByRole('button', { name: 'Save settings' })).toBeVisible();
    expect(await overflows(page)).toBe(false);
    await shot(page, testInfo, 'admin-desktop-settings-group.png');
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

    // Settings: its groups are the list, and a group links back to Settings.
    await page.goto(`/admin/settings`);
    await shot(page, testInfo, 'admin-mobile-settings.png');
    await main.getByRole('link', { name: /^Sandbox & code/ }).click();
    await page.waitForURL(/\/admin\/settings\/sandbox$/);
    await expect(main.getByRole('heading', { level: 1, name: 'Sandbox & code' })).toBeVisible();
    expect(await overflows(page)).toBe(false);
    await shot(page, testInfo, 'admin-mobile-settings-group.png');
    await main.getByRole('link', { name: 'Settings', exact: true }).click();
    await page.waitForURL(/\/admin\/settings$/);
  });
});

test('someone who is not an operator gets no sidebar', async ({ page, person: _person }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const main = page.getByRole('main');
  await page.goto(`/admin`);
  await expect(main.getByRole('heading', { name: 'Operator access required' })).toBeVisible();
  await expect(main.getByRole('navigation', { name: 'Organization areas' })).toHaveCount(0);
});
