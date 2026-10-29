/**
 * First-run setup (app/setup): the page a deployment with no identity
 * provider shows, and the SETUP_SECRET from the app's environment that
 * gates the first configuration (lib/setup-secret.ts; the memory config
 * starts the server with e2e/setup-secret.ts's value).
 *
 * What decides "first run" is whether an identity provider is stored
 * (`identityProviderConfigured()`, the `oidc_config` row). The memory
 * server starts with none, and nothing in the suite can write one: the
 * only route that does (POST /api/oidc) first fetches the provider's
 * discovery document from the server, and no provider answers in e2e. So
 * every spec on the shared server sees first run — sign-in goes through
 * the test session route, which the setup page does not touch — and this
 * spec needs neither a server of its own nor anything to put back. It
 * signs nobody in: setup happens before anyone can.
 *
 * Pinned Chromium; mobile is a viewport resize.
 */

import path from 'node:path';
import type { Page, TestInfo } from '@playwright/test';
import { E2E_SETUP_SECRET } from './constants';
import { test, expect } from './fixtures';

const RESULTS = path.join(import.meta.dirname, '..', 'test-results');

async function shot(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  await page.screenshot({
    path: path.join(RESULTS, 'screens', testInfo.project.name, `setup-${name}.png`),
    fullPage: true,
  });
}

async function fillProvider(page: Page, secret: string): Promise<void> {
  await page
    .getByLabel('OpenID Connect discovery URL')
    .fill('https://idp.example.com/.well-known/openid-configuration');
  await page.getByLabel('Client ID').fill('renkei-e2e');
  await page.getByLabel('Client secret').fill('not-a-real-secret');
  await page.getByLabel('Setup secret', { exact: false }).fill(secret);
}

/** Still first run: the setup page renders its form instead of sending the browser on. */
async function expectStillUnconfigured(page: Page): Promise<void> {
  const response = await page.request.get('/setup', { maxRedirects: 0 });
  expect(response.status()).toBe(200);
  expect(await response.text()).toContain('Save and continue');
}

test('a deployment with no identity provider is set up from the setup page', async ({
  page,
}, testInfo) => {
  test.setTimeout(240_000);

  // ── Starting sign-in goes to setup: there is nothing to sign in with ──
  await page.goto('/api/auth/oidc/login');
  await expect(page).toHaveURL(/\/setup$/);
  await expect(page.getByRole('heading', { name: 'Set up Renkei' })).toBeVisible();
  await expect(page.getByText("enter the setup secret from the app's environment")).toBeVisible();
  await expect(page.getByLabel('Setup secret', { exact: false })).toBeVisible();
  await shot(page, testInfo, '01-form');

  // ── A wrong secret is refused, and nothing is configured ──
  await fillProvider(page, 'not-the-secret');
  await page.getByRole('button', { name: 'Save and continue' }).click();
  // Next's route announcer is a second role=alert, so the form's own.
  const alert = page.locator('p[role="alert"]');
  await expect(alert).toContainText('The setup secret is missing or wrong');
  await expectStillUnconfigured(page);
  await shot(page, testInfo, '02-refused');

  // ── The right one gets past the gate: what fails now is the provider
  //    itself (nothing answers at idp.example.com), not the secret, and
  //    the secret is as good for the next try as it was for this one ──
  await page.getByLabel('Setup secret', { exact: false }).fill(E2E_SETUP_SECRET);
  await page.getByRole('button', { name: 'Save and continue' }).click();
  await expect(alert).toBeVisible();
  await expect(alert).not.toContainText('setup secret');
  await expectStillUnconfigured(page);

  // ── The API refuses the same two ways with no browser in between ──
  const bare = await page.request.post('/api/oidc', {
    data: { discoveryEndpoint: 'https://idp.example.com/x', clientId: 'a', clientSecret: 'b' },
  });
  expect(bare.status()).toBe(401);
  const wrong = await page.request.post('/api/oidc', {
    headers: { 'x-renkei-setup-secret': 'not-the-secret' },
    data: { discoveryEndpoint: 'https://idp.example.com/x', clientId: 'a', clientSecret: 'b' },
  });
  expect(wrong.status()).toBe(401);
  await expectStillUnconfigured(page);

  // ── Phone width: the form still reads top to bottom ──
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/setup');
  await expect(page.getByRole('heading', { name: 'Set up Renkei' })).toBeVisible();
  await expect(page.getByLabel('Client secret')).toBeVisible();
  await shot(page, testInfo, '03-mobile');
});
