/**
 * First-run setup (app/setup): the page a deployment with no identity
 * provider shows, and the SETUP_SECRET from the app's environment that
 * gates the first configuration (lib/setup-secret.ts; the Playwright config
 * starts the dev server with e2e/setup-secret.ts's value). The spec takes
 * the deployment's identity provider away for its own duration — sign-in
 * starts land on the setup page, a wrong secret is refused in the browser,
 * the right one gets past the gate — and puts whatever was there back. That
 * row is the one deployment's, not a person's, so this spec is not safe
 * beside a spec that signs in through OIDC; the rest sign in with seeded
 * session cookies, which the setup page does not touch. Pinned Chromium;
 * mobile is a viewport resize.
 */

import path from 'node:path';
import { test, expect, type Page, type TestInfo } from '@playwright/test';
import { Client } from 'pg';
import { E2E_SETUP_SECRET } from './setup-secret';

const RESULTS = path.join(import.meta.dirname, '..', 'test-results');

test.use({
  launchOptions: {
    executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    args: ['--no-sandbox'],
  },
});
test.describe.configure({ mode: 'serial' });

async function withDb<T>(fn: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

type OidcRow = Record<string, unknown>;

/** Take the identity provider away; the secret is the server's environment, not a row. */
async function enterSetup(): Promise<OidcRow[]> {
  return withDb(async (client) => {
    const saved = await client.query<OidcRow>('SELECT * FROM oidc_config');
    await client.query('DELETE FROM oidc_config');
    return saved.rows;
  });
}

/** The provider back as it was. */
async function leaveSetup(saved: OidcRow[]): Promise<void> {
  await withDb(async (client) => {
    await client.query('DELETE FROM oidc_config');
    for (const row of saved) {
      const columns = Object.keys(row);
      await client.query(
        `INSERT INTO oidc_config (${columns.join(', ')}) VALUES (${columns.map((_, i) => `$${i + 1}`).join(', ')})`,
        columns.map((column) => row[column])
      );
    }
  });
}

async function configuredCount(): Promise<number> {
  const result = await withDb((client) => client.query('SELECT count(*)::int AS n FROM oidc_config'));
  return result.rows[0].n;
}

async function shot(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  await page.screenshot({
    path: path.join(RESULTS, 'screens', testInfo.project.name, `setup-${name}.png`),
    fullPage: true,
  });
}

async function fillProvider(page: Page, secret: string): Promise<void> {
  await page.getByLabel('OpenID Connect discovery URL').fill(
    'https://idp.example.com/.well-known/openid-configuration'
  );
  await page.getByLabel('Client ID').fill('renkei-e2e');
  await page.getByLabel('Client secret').fill('not-a-real-secret');
  await page.getByLabel('Setup secret', { exact: false }).fill(secret);
}

test('a deployment with no identity provider is set up from the setup page', async ({ page }, testInfo) => {
  test.setTimeout(240_000);
  const saved = await enterSetup();
  try {
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
    expect(await configuredCount()).toBe(0);
    await shot(page, testInfo, '02-refused');

    // ── The right one gets past the gate: what fails now is the provider
    //    itself (nothing answers at idp.example.com), not the secret, and
    //    the secret is as good for the next try as it was for this one ──
    await page.getByLabel('Setup secret', { exact: false }).fill(E2E_SETUP_SECRET);
    await page.getByRole('button', { name: 'Save and continue' }).click();
    await expect(alert).toBeVisible();
    await expect(alert).not.toContainText('setup secret');
    expect(await configuredCount()).toBe(0);

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
    expect(await configuredCount()).toBe(0);

    // ── Phone width: the form still reads top to bottom ──
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/setup');
    await expect(page.getByRole('heading', { name: 'Set up Renkei' })).toBeVisible();
    await expect(page.getByLabel('Client secret')).toBeVisible();
    await shot(page, testInfo, '03-mobile');
  } finally {
    await leaveSetup(saved);
  }

  // ── With a provider back, the setup page is gone ──
  if (saved.length > 0) {
    await page.goto('/setup');
    await expect(page).not.toHaveURL(/\/setup$/);
  }
});
