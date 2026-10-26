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
import { test, expect } from './worker-env';
import { isolateFile } from './worker-env';

// Each file starts from a database of its own: this runs before the file's other hooks.
test.beforeAll(isolateFile);
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
    await page.goto(`/preferences`);
    await expect(page.getByRole('heading', { name: 'Preferences' })).toBeVisible();

    // Everything sits under one Notifications heading now.
    await expect(page.getByRole('heading', { name: 'Notifications', exact: true })).toBeVisible();
    const group = page.getByRole('region', { name: 'Notifications' });
    await expect(group.getByRole('heading', { name: 'Runs' })).toBeVisible();
    await expect(group.getByRole('heading', { name: 'Things your agents do' })).toBeVisible();
    await expect(group.getByRole('heading', { name: 'Pop-ups' })).toBeVisible();

    // Each connector's kinds of action are a table in a scroll box; nothing
    // may spill out of the viewport sideways.
    const measure = async (connector: string) => {
      const details = page.locator('details', { hasText: connector }).first();
      await details.locator('summary').click();
      return {
        items: await details.locator('tbody tr').count(),
        overflow: await page.evaluate(
          () => document.documentElement.scrollWidth > window.innerWidth + 1
        ),
      };
    };

    const jira = await measure('Jira');
    expect(jira.items).toBeGreaterThan(0);
    expect(jira.overflow).toBe(false);

    await page.locator('details', { hasText: 'Jira' }).first().locator('summary').click();

    const webex = await measure('WebEx');
    expect(webex.items).toBeGreaterThan(0);
    expect(webex.overflow).toBe(false);
    await page.locator('details', { hasText: 'WebEx' }).first().locator('summary').click();
    await page.locator('details', { hasText: 'Jira' }).first().locator('summary').click();

    console.log(`${size.name} ${size.width}px → Jira ${jira.items} rows, WebEx ${webex.items} rows`);

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
