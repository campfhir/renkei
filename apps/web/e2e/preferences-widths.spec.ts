/**
 * Preferences at four widths: grouped into sections behind a sidebar inside
 * the main area on a wide screen, and on a phone a section list that opens
 * each section with a link back. Notifications is the long section: each
 * connector's kinds of action open as a table, a row per kind and a column
 * per channel, inside a panel as wide as the page, not the viewport. What
 * is measured is that nothing spills out sideways, at a phone's width as
 * at an ultrawide's.
 *
 * Which section a path is, the groups, and the overview's lines are
 * preferences/preferences-nav.model.test.ts's.
 */

import path from 'node:path';
import type { Page, TestInfo } from '@playwright/test';
import { test, expect } from './fixtures';

const WIDTHS = [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'tablet', width: 834, height: 1112 },
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'ultrawide', width: 2560, height: 1200 },
];

/** The app's menu becomes a drawer below this width, and Preferences' sidebar a section list. */
const WIDE = 1024;

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

for (const size of WIDTHS) {
  test(`preferences at ${size.name} (${size.width}px)`, async ({
    page,
    person: _person,
  }, testInfo) => {
    await page.setViewportSize({ width: size.width, height: size.height });
    const main = page.getByRole('main');
    const sidebar = main.getByRole('navigation', { name: 'Preferences sections' });

    // The section list: every group, each section a link with where it stands.
    await page.goto(`/preferences`);
    await expect(main.getByRole('heading', { level: 1, name: 'Preferences' })).toBeVisible();
    for (const group of ['General', 'Tools & automation', 'Notifications', 'Account']) {
      await expect(main.getByRole('heading', { level: 2, name: group })).toBeVisible();
    }
    // The person's own state, not the organization's (the locked list is shared).
    await expect(main.getByRole('link', { name: /^Chats/ }).last()).toContainText(
      'Never archived automatically'
    );
    expect(await overflows(page)).toBe(false);
    await shot(page, testInfo, `prefs-${size.name}-sections.png`);

    if (size.width >= WIDE) {
      // A wide screen: the sidebar beside the section, the current one marked.
      await sidebar.getByRole('link', { name: 'Notifications', exact: true }).click();
      await expect(page).toHaveURL(/\/preferences\/notifications$/);
      await expect(
        sidebar.getByRole('link', { name: 'Notifications', exact: true })
      ).toHaveAttribute('aria-current', 'page');
      // Its cards listed under it, a link to each.
      await expect(sidebar.getByRole('link', { name: 'Pop-ups' })).toHaveAttribute(
        'href',
        '#notify-popups'
      );
    } else {
      // A phone: no sidebar; a section opens from the list, with a way back.
      await expect(sidebar).toBeHidden();
      await main.getByRole('link', { name: /^Notifications/ }).click();
      await expect(page).toHaveURL(/\/preferences\/notifications$/);
      await expect(main.getByRole('link', { name: 'Preferences', exact: true })).toBeVisible();
      await expect(
        main.getByRole('navigation', { name: 'Notification cards' }).getByRole('link', {
          name: 'Pop-ups',
        })
      ).toBeVisible();
    }

    // Everything sits under one Notifications heading.
    const group = main.getByRole('region', { name: 'Notifications' });
    await expect(group.getByRole('heading', { name: 'Runs' })).toBeVisible();
    await expect(group.getByRole('heading', { name: 'Things your agents do' })).toBeVisible();
    await expect(group.getByRole('heading', { name: 'Pop-ups' })).toBeVisible();

    // Each connector's kinds of action are a table of rows (one per kind,
    // a column per channel); nothing may spill out of the viewport sideways.
    const measure = async (connector: string) => {
      await main.locator('details', { hasText: connector }).first().locator('summary').click();
      return page.evaluate(() => {
        const rows = [...document.querySelectorAll('details[open] table tbody tr')];
        // A table wider than a phone scrolls inside its own region (the
        // table's parent): that region is what must fit.
        const regions = [...document.querySelectorAll('details[open] table')].map(
          (table) => table.parentElement
        );
        return {
          rows: rows.length,
          overflow: document.documentElement.scrollWidth > window.innerWidth + 1,
          clipped: regions.some(
            (region) => (region?.getBoundingClientRect().right ?? 0) > window.innerWidth + 1
          ),
        };
      });
    };

    const jira = await measure('Jira');
    expect(jira.rows).toBeGreaterThanOrEqual(4);
    expect(jira.overflow).toBe(false);
    expect(jira.clipped).toBe(false);
    await main.locator('details', { hasText: 'Jira' }).first().locator('summary').click();

    const webex = await measure('WebEx');
    expect(webex.rows).toBeGreaterThan(0);
    expect(webex.overflow).toBe(false);
    expect(webex.clipped).toBe(false);
    await main.locator('details', { hasText: 'WebEx' }).first().locator('summary').click();
    await shot(page, testInfo, `prefs-${size.name}.png`);

    // The new sections fit too: Agents and Code projects.
    await page.goto(`/preferences/agents`);
    await expect(main.getByRole('region', { name: 'Runs without asking' })).toBeVisible();
    expect(await overflows(page)).toBe(false);
    await page.goto(`/preferences/code`);
    await expect(main.getByRole('region', { name: 'High risk in Auto mode' })).toBeVisible();
    expect(await overflows(page)).toBe(false);
    await shot(page, testInfo, `prefs-${size.name}-code.png`);
  });
}
