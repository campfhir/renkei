/**
 * Organization → Sandboxes: an operator says where the organization's
 * sandboxes are made (an Azure sandbox group) and what each is started
 * with, saves it, and finds it there again with its secrets stored but
 * not shown; "Test connection" answers in a sentence. The form's rules
 * are sandboxes-form.model.test.ts's and what a valid setup is the
 * route's (app/api/admin/sandboxes/route.test.ts); this is the path end
 * to end, the page on a phone, and how it looks.
 *
 * The setup is organization-wide: this spec is its only writer, runs
 * once (desktop-light, the dark theme a screenshot), and leaves it
 * switched off. The suite runs no orchestrator, so nothing reads it.
 */

import path from 'node:path';
import type { Page, TestInfo } from '@playwright/test';
import { test, expect } from './fixtures';

const RESULTS = path.join(import.meta.dirname, '..', 'test-results');

test.use({ roles: ['renkei-user', 'renkei-operator'] });

async function shot(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  await page.screenshot({
    path: path.join(RESULTS, 'screens', testInfo.project.name, `admin-sandboxes-${name}.png`),
    fullPage: true,
  });
}

test('an operator sets up where sandboxes are made', async ({
  page,
  person: _person,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== 'desktop-light',
    'The sandbox setup is shared by every project: one writer, the dark theme as a screenshot.'
  );
  test.setTimeout(240_000);

  await page.goto('/admin/sandboxes');
  const main = page.getByRole('main');
  await expect(main.getByRole('heading', { name: 'Where sandboxes are made' })).toBeVisible();
  // No orchestrator in the suite: the page says nothing here is in use.
  await expect(main.getByText(/runs no sandbox orchestrator/)).toBeVisible();
  await shot(page, testInfo, '01-empty');

  try {
    await main
      .getByLabel('Orchestrator address, as sandboxes reach it')
      .fill('https://orchestrator.internal:8097');
    await main.getByLabel('Subscription id').fill('bcc23553-20c2-4009-a5e2-ef2740dd125f');
    await main.getByLabel('Resource group').fill('PRD_INFRA');
    await main.getByLabel('Sandbox group').fill('renkei-sandbox-group');
    await main.getByLabel('Region').fill('eastus2');
    await main.getByLabel('Disk image').fill('renkei-sandbox');
    await main.getByLabel('Allowed identities').fill('orchestrator@contoso.com');

    // A setup that is not complete is refused in a sentence, and nothing typed is lost.
    await main.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(main.getByRole('alert')).toContainText('Enter a value for DELEGATE_WORKER_URL.');
    await expect(main.getByLabel('Sandbox group')).toHaveValue('renkei-sandbox-group');

    // Keep one variable, with a value; the rest go.
    await main.getByLabel('Variable 1 value').fill('http://renkei-worker-delegate:8096');
    for (const name of [
      'LOG_ENCRYPTION_KEY',
      'SANDBOX_ENV_SECRETS_KEY',
      'DELEGATE_WORKER_API_KEY',
    ]) {
      await main.getByRole('button', { name: `Remove variable ${name}` }).click();
    }
    const saved = page.waitForResponse(
      (response) =>
        response.url().endsWith('/api/admin/sandboxes') && response.request().method() === 'PUT'
    );
    await main.getByRole('button', { name: 'Save', exact: true }).click();
    const answer = await (await saved).text();
    // The server never answers a secret back.
    expect(answer).not.toContain('renkei-worker-delegate');
    await expect(main.getByText('Saved.')).toBeVisible();
    await expect(main.getByText('Enabled', { exact: true }).first()).toBeVisible();
    await shot(page, testInfo, '02-saved');

    // Found again on a fresh load: the settings shown, the secret stored but not shown.
    await page.goto('/admin/sandboxes');
    await expect(main.getByLabel('Sandbox group')).toHaveValue('renkei-sandbox-group');
    await expect(main.getByLabel('Variable 1 name')).toHaveValue('DELEGATE_WORKER_URL');
    const value = main.getByLabel('Variable 1 value');
    await expect(value).toHaveValue('');
    await expect(value).toHaveAttribute('placeholder', /stored; leave blank to keep/);

    // Test connection answers in a sentence (here: there is no orchestrator to try it with).
    await main.getByRole('button', { name: 'Test connection' }).click();
    await expect(main.getByRole('alert')).toContainText(/runs no sandbox orchestrator/);
    await page.emulateMedia({ colorScheme: 'dark' });
    await shot(page, testInfo, '03-tested-dark');
    await page.emulateMedia({ colorScheme: 'light' });

    // Docker asks for other things.
    await main.getByLabel('Provider').selectOption('docker');
    await expect(main.getByLabel('Sandbox image')).toBeVisible();
    await expect(main.getByLabel('Subscription id')).toHaveCount(0);
    await shot(page, testInfo, '04-docker');

    // Phone width: the page fits.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/admin/sandboxes');
    await expect(page.getByRole('main').getByLabel('Sandbox group')).toBeVisible();
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth
    );
    expect(overflow).toBeLessThanOrEqual(0);
    await shot(page, testInfo, '05-mobile');
  } finally {
    // Left switched off for everyone else on the server.
    const current = await page.request.get('/api/admin/sandboxes');
    const view: unknown = await current.json();
    if (typeof view === 'object' && view !== null && 'configured' in view && view.configured) {
      const settings = 'settings' in view && typeof view.settings === 'object' ? view.settings : {};
      const off = await page.request.put('/api/admin/sandboxes', {
        data: { ...settings, enabled: false, envValues: {} },
      });
      expect(off.ok()).toBe(true);
    }
  }
});
