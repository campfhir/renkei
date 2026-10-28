/**
 * The organization's name (admin → Settings → Organization): what the
 * consent page and the sign-in flow call the deployment. An operator renames
 * it, saves, and the name is what the org-settings route answers and what
 * the consent page an MCP client's user sees would print; the spec puts the
 * default back, since the one organization's settings are shared with every
 * other spec on the server.
 *
 * Organization settings are one row per key for the whole server, and two
 * projects renaming it at once would each read the other's name back, so
 * the flow runs once, in desktop-light, and the dark theme is a screenshot
 * of the same page under `emulateMedia` rather than a second concurrent
 * writer. Pinned Chromium; mobile is a viewport resize.
 */

import path from 'node:path';
import type { Page, TestInfo } from '@playwright/test';
import { test, expect } from './fixtures';

const RESULTS = path.join(import.meta.dirname, '..', 'test-results');
const DEFAULT_NAME = 'Renkei';

test.use({ roles: ['renkei-user', 'renkei-operator'] });

async function shot(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  await page.screenshot({
    path: path.join(RESULTS, 'screens', testInfo.project.name, `organization-name-${name}.png`),
    fullPage: true,
  });
}

async function settings(page: Page): Promise<Record<string, unknown>> {
  const read = await page.request.get('/api/admin/org-settings');
  expect(read.ok()).toBe(true);
  const body: unknown = await read.json();
  const value =
    typeof body === 'object' && body !== null && 'settings' in body ? body.settings : null;
  return typeof value === 'object' && value !== null ? { ...value } : {};
}

test('an operator names the organization', async ({ page, person: _person }, testInfo) => {
  test.skip(
    testInfo.project.name !== 'desktop-light',
    'Organization settings are shared by every project: one writer, the dark theme as a screenshot.'
  );
  test.setTimeout(240_000);
  const name = `Acme Health (${testInfo.project.name})`;

  await page.goto('/admin/settings');
  const field = page.getByRole('textbox', { name: 'Organization name' });
  await expect(field).toBeVisible();
  await field.scrollIntoViewIfNeeded();
  await shot(page, testInfo, '01-default');

  try {
    // ── Rename, save; the API answers the trimmed name ──
    await field.fill(`  ${name}  `);
    await page.getByRole('button', { name: 'Save settings' }).click();
    await expect(page.getByText('Saved.')).toBeVisible();
    expect((await settings(page)).organizationName).toBe(name);
    await shot(page, testInfo, '02-saved');
    await page.emulateMedia({ colorScheme: 'dark' });
    await shot(page, testInfo, '02-saved-dark');
    await page.emulateMedia({ colorScheme: 'light' });

    // ── The API takes a name, not a blank ──
    const refused = await page.request.put('/api/admin/org-settings', {
      data: { organizationName: '   ' },
    });
    expect(refused.status()).toBe(400);
    expect((await settings(page)).organizationName).toBe(name);

    // ── The AD Manager product name, the other name the organization owns ──
    const product = page.getByRole('textbox', { name: 'AD Manager product name' });
    await expect(product).toHaveValue('Renkei');
    await product.fill('Renkei E2E');
    await page.getByRole('button', { name: 'Save settings' }).click();
    await expect(page.getByText('Saved.')).toBeVisible();
    expect((await settings(page)).admanagerProductName).toBe('Renkei E2E');

    // ── Phone width: the field still sits in its section. (The page reads
    //    settings through its own one-minute cache, so what it shows after a
    //    save is not asserted — the API was.) ──
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/admin/settings');
    const narrow = page.getByRole('textbox', { name: 'Organization name' });
    await expect(narrow).toBeVisible();
    await narrow.scrollIntoViewIfNeeded();
    await shot(page, testInfo, '03-mobile');
  } finally {
    // The default back for everyone else on the server.
    const restored = await page.request.put('/api/admin/org-settings', {
      data: { organizationName: DEFAULT_NAME, admanagerProductName: DEFAULT_NAME },
    });
    expect(restored.ok()).toBe(true);
  }
  const after = await settings(page);
  expect(after.organizationName).toBe(DEFAULT_NAME);
  expect(after.admanagerProductName).toBe(DEFAULT_NAME);
});
