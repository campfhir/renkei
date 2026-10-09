/**
 * Onboarding after migration 146, driven in a browser: the identity-provider
 * form mints the tenant, sends the one-time onboarding secret with the
 * identity-provider save, then shows the DNS TXT record to publish and a
 * "Verify now" button; and the sign-in page's pending redirect renders its
 * explanation. The server calls are mocked at the browser edge — the real
 * routes would reach an identity provider and public DNS, which e2e has no
 * business touching — so what is exercised is the page's own wiring: which
 * header it sends, what it shows, what it does with each answer.
 *
 * Pinned Chromium only; mobile is a viewport resize (AGENTS.md).
 */

import path from 'node:path';
import { test, expect, type Page, type TestInfo } from '@playwright/test';

const RESULTS = path.join(import.meta.dirname, '..', 'test-results');
const TENANT = '7e2a4c1b-5d3f-4a8b-9c6d-1e2f3a4b5c6d';
const DOMAIN = 'e2e-onboarding-verify.example';
const SECRET = 'e2e-bootstrap-secret-value-0123456789abcdef';
const RECORD = 'renkei-verify=e2etoken0123456789';

test.use({
  launchOptions: {
    executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    args: ['--no-sandbox'],
  },
  // Onboarding happens before any session exists.
  storageState: { cookies: [], origins: [] },
});

async function shot(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  await page.screenshot({
    path: path.join(RESULTS, 'screens', testInfo.project.name, `${name}.png`),
    fullPage: true,
  });
}

test('create: the save carries the onboarding secret, then the TXT record and verification are shown', async ({
  page,
}, testInfo) => {
  const discovery = 'https://idp.e2e.example/.well-known/openid-configuration';
  await page.route(discovery, (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        issuer: 'https://idp.e2e.example',
        authorization_endpoint: 'https://idp.e2e.example/auth',
        token_endpoint: 'https://idp.e2e.example/token',
      }),
    })
  );
  await page.route('**/api/home-realm/create', (route) =>
    route.fulfill({
      status: 201,
      contentType: 'application/json',
      body: JSON.stringify({
        tenantId: TENANT,
        alreadyExists: false,
        bootstrapSecret: SECRET,
        bootstrapSecretExpiresAt: new Date(Date.now() + 86_400_000).toISOString(),
        domainVerification: { domain: DOMAIN, recordType: 'TXT', record: RECORD },
      }),
    })
  );
  let bootstrapHeader: string | undefined;
  await page.route(`**/api/tenant/${TENANT}/oidc`, (route) => {
    bootstrapHeader = route.request().headers()['x-renkei-bootstrap-secret'];
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: true, tenantId: TENANT }),
    });
  });
  let verifyCalls = 0;
  await page.route(`**/api/tenant/${TENANT}/verify-domain`, (route) => {
    verifyCalls += 1;
    return verifyCalls === 1
      ? route.fulfill({
          status: 409,
          contentType: 'application/json',
          body: JSON.stringify({
            verified: false,
            expected: { recordType: 'TXT', record: RECORD },
            domains: [{ domain: DOMAIN, reason: 'no-record' }],
          }),
        })
      : route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ verified: true, domain: DOMAIN }),
        });
  });

  await page.goto(`/create-organization?domain=${DOMAIN}`);
  await expect(page.getByRole('heading', { name: 'Set up your identity provider' })).toBeVisible();

  await page
    .getByPlaceholder('https://auth.example.com/.well-known/openid-configuration')
    .fill(discovery);
  await page.getByRole('button', { name: 'Test', exact: true }).click();
  await expect(page.getByText('Discovery validated')).toBeVisible();
  await page.getByPlaceholder('your-client-id').fill('e2e-client');
  await page.getByPlaceholder('your-client-secret').fill('e2e-client-secret');
  await page.getByRole('button', { name: 'Save Identity Provider Configuration' }).click();

  const steps = page.getByTestId('domain-verification-steps');
  await expect(steps).toBeVisible();
  expect(bootstrapHeader).toBe(SECRET);
  await expect(page.getByTestId('domain-verification-record')).toHaveText(RECORD);
  await expect(steps).toContainText(DOMAIN);
  await shot(page, testInfo, 'onboarding-01-record-shown');

  await page.getByRole('button', { name: 'Verify now' }).click();
  await expect(steps).toContainText('Not visible yet');
  await expect(steps).toContainText('no-record');
  await page.getByRole('button', { name: 'Verify now' }).click();
  await expect(page.getByRole('button', { name: 'Verified' })).toBeDisabled();
  expect(verifyCalls).toBe(2);
  await expect(steps.getByRole('link', { name: 'Continue to sign in' })).toHaveAttribute(
    'href',
    `/api/auth/oidc/login?tenantId=${TENANT}`
  );
  await shot(page, testInfo, 'onboarding-02-verified');

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByTestId('domain-verification-record')).toBeVisible();
  await shot(page, testInfo, 'onboarding-03-mobile');
});

test('create: a claimed domain is refused without revealing its tenant', async ({ page }) => {
  const discovery = 'https://idp.e2e.example/.well-known/openid-configuration';
  await page.route(discovery, (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ issuer: 'https://idp.e2e.example' }),
    })
  );
  await page.route('**/api/home-realm/create', (route) =>
    route.fulfill({
      status: 409,
      contentType: 'application/json',
      body: JSON.stringify({
        error:
          'This domain already belongs to an organization. Sign in from the home page, or ask its administrator.',
        alreadyExists: true,
      }),
    })
  );
  let oidcCalled = false;
  await page.route('**/api/tenant/*/oidc', (route) => {
    oidcCalled = true;
    return route.fulfill({ status: 500, body: '{}' });
  });

  await page.goto(`/create-organization?domain=${DOMAIN}`);
  await page
    .getByPlaceholder('https://auth.example.com/.well-known/openid-configuration')
    .fill(discovery);
  await page.getByRole('button', { name: 'Test', exact: true }).click();
  await expect(page.getByText('Discovery validated')).toBeVisible();
  await page.getByPlaceholder('your-client-id').fill('e2e-client');
  await page.getByPlaceholder('your-client-secret').fill('e2e-client-secret');
  await page.getByRole('button', { name: 'Save Identity Provider Configuration' }).click();

  await expect(page.getByText('This domain already belongs to an organization')).toBeVisible();
  expect(oidcCalled).toBe(false);
  await expect(page.getByTestId('domain-verification-steps')).toHaveCount(0);
});

test('pending: a claimed-but-unverified domain explains the TXT record on the onboarding page', async ({
  page,
}, testInfo) => {
  await page.goto(`/create-organization?domain=${DOMAIN}&pending=1`);
  const banner = page.getByTestId('domain-pending');
  await expect(banner).toBeVisible();
  await expect(banner).toContainText(`${DOMAIN} is waiting for domain verification`);
  await expect(banner).toContainText('renkei-verify=');
  await shot(page, testInfo, 'onboarding-04-pending');
});
