/**
 * Code services from the operator's side, in a browser: the allow-list of
 * container images a code project's chat may start beside its checkout,
 * at /admin/code-services. The sandbox worker is the stub in
 * sandbox-stub.mjs, which seeds the same public images migration 122 does
 * and normalizes a rule the way the worker would. The page renders the
 * seeded images with their shapes; the org's private registry with a
 * credential is added through the form — the one press through: the
 * request reaches the route and the worker, and the row is drawn with the
 * username it is pulled as and never the secret; the organization page
 * lists the area; and the page is checked at phone width. Screenshots
 * land under test-results/screens/<project>/code-services-*.png.
 *
 * Where its rules went: the shapes, when Save can be pressed, what it
 * sends, the credential kept, replaced or removed on an edit, the
 * tag-dropped, restored and refused-duplicate messages are
 * app/(app)/admin/code-services/image-rule-forms.model.test.ts; what the
 * routes hand the worker and pass back is
 * app/api/admin/code-services/rules/route.test.ts.
 *
 * An operator's page: the test's person has the role.
 */

import path from 'node:path';
import type { APIRequestContext } from '@playwright/test';
import { test, expect } from './fixtures';
import { prepareCodeHost } from './support/code-host';

test.use({ roles: ['renkei-user', 'renkei-operator'] });

/** Per-project registry: the Playwright projects share one stub tenant. */
function registryFor(project: string): string {
  const digit = { 'desktop-light': '1', 'desktop-dark': '2', mobile: '3' }[project] ?? '4';
  return `acme${digit}.azurecr.io`;
}

/** This project's own rule goes, through the routes the page calls (the stub keeps rules across runs). */
async function removeRule(request: APIRequestContext, pattern: string): Promise<void> {
  const listed: { rules: { id: string; pattern: string }[] } = await (
    await request.get('/api/admin/code-services/rules')
  ).json();
  for (const rule of listed.rules.filter((row) => row.pattern === pattern)) {
    expect((await request.delete(`/api/admin/code-services/rules/${rule.id}`)).ok()).toBe(true);
  }
}

test.describe('code services', () => {
  test('the allow-list: seeded images, and a private registry added with a credential', async ({
    page,
    request,
    person: _person,
  }, testInfo) => {
    // The page manages the rules only while services are switched on.
    await prepareCodeHost(request);
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
    await removeRule(page.request, registry);

    try {
      // ── The admin page: the seeded public images, each with its shape ──
      await page.goto(`/admin/code-services`);
      await expect(page.getByRole('heading', { level: 1, name: 'Code services' })).toBeVisible();
      const list = page.getByRole('list', { name: 'Allowed images' });
      /** The row whose pattern is exactly this — `acme.azurecr.io` is not `acme.azurecr.io/platform/*`. */
      const rowFor = (pattern: string) =>
        list.locator('li').filter({ has: page.getByText(pattern, { exact: true }) });
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

      // ── The organization page lists the area ──
      await page.goto(`/admin`);
      await expect(page.getByRole('link', { name: /Code services/ })).toBeVisible();

      // ── Phone width: the list and the form still fit ──
      await page.setViewportSize({ width: 390, height: 844 });
      await page.goto(`/admin/code-services`);
      await expect(page.getByRole('heading', { level: 1, name: 'Code services' })).toBeVisible();
      await expect(list.getByText('docker.io/library/postgres')).toBeVisible();
      await page.getByRole('button', { name: '+ New rule' }).click();
      await expect(page.getByLabel('Rule', { exact: true })).toBeVisible();
      const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
      expect(scrollWidth).toBeLessThanOrEqual(390);
      await shot('code-services-admin-mobile.png');
    } finally {
      await removeRule(page.request, registry);
    }
  });
});
