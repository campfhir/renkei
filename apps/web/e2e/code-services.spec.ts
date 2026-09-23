/**
 * Code services from the operator's side: the allow-list of container
 * images a code project's chat may start beside its checkout, managed at
 * /admin/code-services. The sandbox worker is the stub in
 * sandbox-stub.mjs, which seeds the same public images migration 122
 * does and normalizes a rule the way the worker would (a tag dropped
 * and said so, a namespace kept as `/*`). The org's private registry
 * with a credential is added through the form, its username shown and
 * its secret never echoed, then removed; the defaults are restored; and
 * the page is checked at phone width. Screenshots land under
 * test-results/screens/<project>/code-services-*.png.
 */

import path from 'node:path';
import { test, expect } from '@playwright/test';
import { E2E_SLUG } from './seed';

test.use({
  browserName: 'chromium',
  launchOptions: {
    executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    args: ['--no-sandbox'],
  },
});

/** Per-project registry: the three Playwright projects share one stub tenant. */
function registryFor(project: string): string {
  const digit = { 'desktop-light': '1', 'desktop-dark': '2', mobile: '3' }[project] ?? '4';
  return `acme${digit}.azurecr.io`;
}

test.describe('code services', () => {
  test('the allow-list: seeded images, a private registry with a credential, defaults restored', async ({
    page,
  }, testInfo) => {
    const registry = registryFor(testInfo.project.name);
    const shot = (name: string) =>
      page.screenshot({
        path: path.join(
          import.meta.dirname,
          '..',
          'test-results',
          'screens',
          testInfo.project.name,
          name
        ),
        fullPage: false,
      });

    // ── The admin page: the seeded public images, each with its shape ──
    await page.goto(`/${E2E_SLUG}/admin/code-services`);
    await expect(page.getByRole('heading', { level: 1, name: 'Code services' })).toBeVisible();
    const list = page.getByRole('list', { name: 'Allowed images' });
    /** The row whose pattern is exactly this — `acme.azurecr.io` is not `acme.azurecr.io/platform/*`. */
    const rowFor = (pattern: string) =>
      list.locator('li').filter({ has: page.getByText(pattern, { exact: true }) });
    // The stub keeps its rules in memory across runs (reuseExistingServer):
    // whatever an earlier run of this project left behind goes first.
    for (const pattern of [registry, `${registry}/platform/*`, 'docker.io/bitnami/postgresql']) {
      while ((await rowFor(pattern).count()) > 0) {
        await rowFor(pattern).first().getByRole('button', { name: 'Delete' }).click();
        await expect(rowFor(pattern)).toHaveCount(0);
      }
    }
    await expect(list.getByText('docker.io/library/postgres')).toBeVisible();
    await expect(list.getByText('mcr.microsoft.com/azure-storage/azurite')).toBeVisible();
    await expect(rowFor('docker.io/library/redis')).toContainText('repository');
    await shot('code-services-admin-list.png');

    // ── A private registry, whole, with the service principal it is
    //    pulled as: the username is shown, the secret is not ──
    await page.getByRole('button', { name: '+ New rule' }).click();
    await page.getByLabel('Rule', { exact: true }).fill(`${registry.toUpperCase()}/`);
    await page.getByLabel(/^Note/).fill('Our platform team’s registry');
    await page.getByLabel('Username').fill('sp-renkei-pull');
    await page.getByLabel('Secret').fill('super-secret-value');
    await shot('code-services-admin-new-registry.png');
    await page.getByRole('button', { name: 'Add rule' }).click();
    const registryRow = rowFor(registry);
    await expect(registryRow).toBeVisible();
    await expect(registryRow).toContainText('whole registry');
    await expect(registryRow).toContainText('Pulled as sp-renkei-pull');
    await expect(page.getByText('super-secret-value')).toHaveCount(0);
    await shot('code-services-admin-list-with-registry.png');

    // ── A rule typed with a tag is saved without it, and the page says so ──
    await page.getByRole('button', { name: '+ New rule' }).click();
    await page.getByLabel('Rule', { exact: true }).fill(`${registry}/platform/*`);
    await page.getByRole('button', { name: 'Add rule' }).click();
    await expect(rowFor(`${registry}/platform/*`)).toContainText('namespace');
    await page.getByRole('button', { name: '+ New rule' }).click();
    await page.getByLabel('Rule', { exact: true }).fill('bitnami/postgresql:16');
    await page.getByRole('button', { name: 'Add rule' }).click();
    await expect(page.getByRole('status').filter({ hasText: /./ })).toContainText(
      'Saved without the tag 16'
    );
    await expect(list.getByText('docker.io/bitnami/postgresql')).toBeVisible();
    await shot('code-services-admin-tag-dropped.png');

    // ── A duplicate is refused ──
    await page.getByRole('button', { name: '+ New rule' }).click();
    await page.getByLabel('Rule', { exact: true }).fill('postgres');
    await page.getByRole('button', { name: 'Add rule' }).click();
    // Next's own route announcer is an alert too; the form's is the one with text.
    await expect(page.getByRole('alert').filter({ hasText: /./ })).toContainText('already exists');
    await page.getByRole('button', { name: 'Cancel' }).click();

    // ── Editing the registry rule: the credential it carries can be kept,
    //    replaced or removed ──
    await registryRow.getByRole('button', { name: 'Edit' }).click();
    await expect(page.getByText('This rule carries a credential.')).toBeVisible();
    await page.getByRole('button', { name: 'remove it' }).click();
    await expect(page.getByText('The credential is removed on save.')).toBeVisible();
    await shot('code-services-admin-edit-clear-credential.png');
    await page.getByRole('button', { name: 'Save rule' }).click();
    await expect(registryRow).not.toContainText('Pulled as');

    // ── Cleanup of this project's own rows, then the defaults restored
    //    after deleting a seeded one ──
    for (const pattern of [registry, `${registry}/platform/*`, 'docker.io/bitnami/postgresql']) {
      await rowFor(pattern).getByRole('button', { name: 'Delete' }).click();
      await expect(rowFor(pattern)).toHaveCount(0);
    }
    await rowFor('docker.io/library/mongo').getByRole('button', { name: 'Delete' }).click();
    await expect(rowFor('docker.io/library/mongo')).toHaveCount(0);
    await page.getByRole('button', { name: 'Restore default images' }).click();
    await expect(page.getByRole('status').filter({ hasText: /./ })).toContainText(
      /Put \d+ default image/
    );
    await expect(list.getByText('docker.io/library/mongo')).toBeVisible();
    await shot('code-services-admin-restored.png');

    // ── The organization page lists the area ──
    await page.goto(`/${E2E_SLUG}/admin`);
    await expect(page.getByRole('link', { name: /Code services/ })).toBeVisible();

    // ── Phone width: the list and the form still fit ──
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`/${E2E_SLUG}/admin/code-services`);
    await expect(page.getByRole('heading', { level: 1, name: 'Code services' })).toBeVisible();
    await expect(list.getByText('docker.io/library/postgres')).toBeVisible();
    await page.getByRole('button', { name: '+ New rule' }).click();
    await expect(page.getByLabel('Rule', { exact: true })).toBeVisible();
    const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
    expect(scrollWidth).toBeLessThanOrEqual(390);
    await shot('code-services-admin-mobile.png');
  });
});
