/**
 * The preferences page at four widths.
 *
 * Each connector's kinds of action open as a table — a row per kind, a
 * column per channel — inside a panel whose width is the page's, not the
 * viewport's. What is measured is that nothing in it spills out sideways,
 * at a phone's width as at an ultrawide's.
 */

import path from 'node:path';
import { test, expect } from './fixtures';

const WIDTHS = [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'tablet', width: 834, height: 1112 },
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'ultrawide', width: 2560, height: 1200 },
];

for (const size of WIDTHS) {
  test(`preferences at ${size.name} (${size.width}px)`, async ({
    page,
    person: _person,
  }, testInfo) => {
    await page.setViewportSize({ width: size.width, height: size.height });
    await page.goto(`/preferences`);
    await expect(page.getByRole('heading', { name: 'Preferences' })).toBeVisible();

    // Everything sits under one Notifications heading now.
    await expect(page.getByRole('heading', { name: 'Notifications', exact: true })).toBeVisible();
    const group = page.getByRole('region', { name: 'Notifications' });
    await expect(group.getByRole('heading', { name: 'Runs' })).toBeVisible();
    await expect(group.getByRole('heading', { name: 'Things your agents do' })).toBeVisible();
    await expect(group.getByRole('heading', { name: 'Pop-ups' })).toBeVisible();

    // Each connector's kinds of action are a table of rows (one per kind,
    // a column per channel); nothing may spill out of the viewport sideways.
    const measure = async (connector: string) => {
      await page.locator('details', { hasText: connector }).first().locator('summary').click();
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
    await page.locator('details', { hasText: 'Jira' }).first().locator('summary').click();

    const webex = await measure('WebEx');
    expect(webex.rows).toBeGreaterThan(0);
    expect(webex.overflow).toBe(false);
    expect(webex.clipped).toBe(false);
    await page.locator('details', { hasText: 'WebEx' }).first().locator('summary').click();

    await page.screenshot({
      path: path.join(
        import.meta.dirname,
        '..',
        '..',
        'test-results',
        'memory',
        'screens',
        testInfo.project.name,
        `prefs-${size.name}.png`
      ),
      fullPage: true,
    });
  });
}
