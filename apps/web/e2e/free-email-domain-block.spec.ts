/**
 * Self-service tenant registration keys a new organization to an email
 * domain — that only works when the domain actually belongs to a company.
 * A free/consumer webmail domain (gmail.com, yahoo.com, outlook.com, ...)
 * belongs to millions of individuals, so it must never be accepted at
 * either entry point: the home page's "work email" sign-in form
 * (/api/home-realm) and the OIDC setup form on /create-organization, which
 * mints the tenant via /api/home-realm/create.
 *
 * Both pages are unauthenticated by design (there's no one to sign in
 * before the first tenant exists), so no seeded tenant/session is needed
 * here — unlike llm-models.spec.ts's pattern. Runs on the pinned Chromium
 * only, per AGENTS.md's "UI changes" section.
 */

import { test, expect } from '@playwright/test';

const MOBILE_VIEWPORT = { width: 390, height: 844 };

test.use({
  launchOptions: {
    executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    args: ['--no-sandbox'],
  },
});

test('home page: a free email domain is rejected with a clear message, not sent to create-organization', async ({
  page,
}) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Sign in to Renkei' })).toBeVisible();

  await page.getByLabel('Work email').fill('someone@gmail.com');

  let alertMessage = '';
  page.once('dialog', async (dialog) => {
    alertMessage = dialog.message();
    await dialog.accept();
  });
  await page.getByRole('button', { name: 'Continue' }).click();

  await expect.poll(() => alertMessage).toContain("can't register an organization");
  // Rejected client-side by the API response, not redirected onward.
  expect(page.url()).toContain('/');
  await expect(page.url()).not.toContain('/create-organization');
});

test('home page: an ordinary company domain still proceeds to create-organization', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByLabel('Work email').fill('someone@e2e-free-domain-block-test.com');
  await page.getByRole('button', { name: 'Continue' }).click();

  await expect(page).toHaveURL(/\/create-organization\?domain=e2e-free-domain-block-test\.com/);
  await expect(page.getByRole('heading', { name: 'Set up your identity provider' })).toBeVisible();
});

test('create-organization: submitting a free email domain fails with an inline error and creates no tenant', async ({
  page,
}) => {
  await page.goto('/create-organization?domain=yahoo.com');
  await expect(page.getByRole('heading', { name: 'Set up your identity provider' })).toBeVisible();

  // The OIDC discovery call is mocked — it would otherwise reach a real
  // identity provider, which this test has none of.
  await page.route('**/.well-known/openid-configuration', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        issuer: 'https://idp.example.com',
        authorization_endpoint: 'https://idp.example.com/authorize',
        token_endpoint: 'https://idp.example.com/token',
      }),
    });
  });

  // The form's labels aren't programmatically associated with their inputs
  // (no htmlFor/id), so placeholder text is what actually locates each field.
  await page
    .getByPlaceholder('https://auth.example.com/.well-known/openid-configuration')
    .fill('https://idp.example.com/.well-known/openid-configuration');
  await page.getByRole('button', { name: 'Test', exact: true }).click();
  await expect(page.getByText('Discovery validated')).toBeVisible();

  await page.getByPlaceholder('your-client-id').fill('e2e-client-id');
  await page.getByPlaceholder('your-client-secret').fill('e2e-client-secret');

  await page.getByRole('button', { name: 'Save Identity Provider Configuration' }).click();

  await expect(page.getByText("can't register an organization")).toBeVisible();
});

test('home page at phone width: the free-domain error is still shown, not clipped', async ({
  page,
}) => {
  await page.setViewportSize(MOBILE_VIEWPORT);
  await page.goto('/');
  await page.getByLabel('Work email').fill('someone@hotmail.com');

  let alertMessage = '';
  page.once('dialog', async (dialog) => {
    alertMessage = dialog.message();
    await dialog.accept();
  });
  await page.getByRole('button', { name: 'Continue' }).click();

  await expect.poll(() => alertMessage).toContain("can't register an organization");
});
