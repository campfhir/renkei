/**
 * The preferences page at four widths.
 *
 * The act lists are laid out with CONTAINER queries, so what decides the
 * column count is the panel's own width — page max-width minus card and
 * panel padding — not the viewport. That indirection is exactly what makes
 * it worth looking at rather than reasoning about: the number below each
 * viewport is measured from the rendered grid, not assumed.
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

const WIDTHS = [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'tablet', width: 834, height: 1112 },
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'ultrawide', width: 2560, height: 1200 },
];

for (const size of WIDTHS) {
  test(`preferences at ${size.name} (${size.width}px)`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: size.width, height: size.height });
    await page.goto(`/${E2E_SLUG}/preferences`);
    await expect(page.getByRole('heading', { name: 'Preferences' })).toBeVisible();

    // Everything sits under one Notifications heading now.
    await expect(page.getByRole('heading', { name: 'Notifications', exact: true })).toBeVisible();
    const group = page.getByRole('region', { name: 'Notifications' });
    await expect(group.getByRole('heading', { name: 'Runs' })).toBeVisible();
    await expect(group.getByRole('heading', { name: 'Things your agents do' })).toBeVisible();
    await expect(group.getByRole('heading', { name: 'Pop-ups' })).toBeVisible();

    // Columns are grouped by the left edge of each item; nothing may spill
    // out of the viewport sideways.
    const measure = async (connector: string) => {
      await page.locator('details', { hasText: connector }).first().locator('summary').click();
      return page.evaluate(() => {
        const items = [...document.querySelectorAll('details[open] ul li')];
        const lefts = new Set(items.map((li) => Math.round(li.getBoundingClientRect().left)));
        return {
          columns: lefts.size,
          items: items.length,
          overflow: document.documentElement.scrollWidth > window.innerWidth + 1,
          clipped: items.some((li) => li.getBoundingClientRect().right > window.innerWidth),
        };
      });
    };

    const jira = await measure('Jira');
    expect(jira.items).toBeGreaterThan(20);
    expect(jira.overflow).toBe(false);
    expect(jira.clipped).toBe(false);
    expect(jira.columns).toBeGreaterThanOrEqual(size.width < 500 ? 1 : 2);

    await page.locator('details', { hasText: 'Jira' }).first().locator('summary').click();

    // WebEx has three acts. Three columns of one item each is not a
    // layout, so the ceiling has to come down with the list length.
    const webex = await measure('WebEx');
    expect(webex.items).toBe(3);
    expect(webex.columns).toBe(1);
    await page.locator('details', { hasText: 'WebEx' }).first().locator('summary').click();
    await page.locator('details', { hasText: 'Jira' }).first().locator('summary').click();

    console.log(`${size.name} ${size.width}px → Jira ${jira.columns}, WebEx ${webex.columns}`);

    await page.screenshot({
      path: path.join(
        import.meta.dirname,
        '..',
        'test-results',
        'screens',
        testInfo.project.name,
        `prefs-${size.name}.png`
      ),
      fullPage: true,
    });
  });
}
