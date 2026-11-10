/**
 * Salesforce, end to end in a browser, with one connector per org: an
 * operator adds the production org through the real admin form and save
 * route (the form's one press-through), a UAT sandbox is put in through
 * the same route, a person finds one card per org on the connectors page,
 * narrows Renkei's capabilities on the sandbox's card (the Connect link
 * follows), connects the sandbox through its link — the one real OAuth
 * walk — and disconnects it again. The admin list is checked at a phone's
 * width.
 *
 * Where the rules went:
 * - the form's defaults (a first CRM org is Production, not a sandbox;
 *   deleting and reassigning start off), the secret kept when blank, the
 *   summary lines and what Save sends: salesforce-form.model.test.ts
 *   beside app/(app)/admin/connectors/forms/salesforce-form.tsx;
 * - the save route's refusals (a login.salesforce.com address, two
 *   connectors on one org, a hidden field without its object), the stored
 *   origin, ceiling and kept-away lists, and removal:
 *   app/api/admin/connectors/salesforce/route.test.ts;
 * - the authorize redirect's query (the org's own My Domain, its consumer
 *   key, PKCE, the fixed scopes), a capability beyond the ceiling (400)
 *   and an unknown connector (503):
 *   app/api/salesforce/[connector]/authorize/route.test.ts.
 *
 * Nothing here reaches Salesforce: on the in-memory app the consent is the
 * app's own fake OAuth (packages/provider-grants/src/fake-oauth.ts); the
 * delegate trades its code for a fake token set naming the sandbox's own
 * instance, and the callback stores the grant as production does.
 *
 * Connector configs are organization-wide: the `salesforce` row is this
 * spec's alone on the server, its two orgs are removed again through the
 * route's own DELETE ?key= before and after, and the flow runs once, in
 * desktop-light, with the dark theme as an `emulateMedia` screenshot. The
 * empty list it starts from is the config's GET answered empty at the
 * browser edge.
 *
 * Runs on the pinned Chromium only; "mobile" is a resized viewport, per AGENTS.md.
 */

import path from 'node:path';
import type { Page, TestInfo } from '@playwright/test';
import { addConnectors } from './support/connectors';
import { test, expect } from './fixtures';

const RESULTS = path.join(import.meta.dirname, '..', 'test-results');
const MOBILE_VIEWPORT = { width: 390, height: 844 };
const PRODUCTION = 'acme-e2e.my.salesforce.com';
const UAT = 'acme-e2e--uat.sandbox.my.salesforce.com';

test.use({ roles: ['renkei-user', 'renkei-operator'] });

async function shot(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  await page.screenshot({
    path: path.join(RESULTS, 'screens', testInfo.project.name, `${name}.png`),
    fullPage: true,
  });
}

interface StoredOrg {
  key: string;
  myDomain: string;
}

const CONFIG = '/api/admin/connectors/salesforce';

/** This spec's orgs go, through the route's own DELETE. */
async function removeOwnOrgs(page: Page): Promise<void> {
  const response = await page.request.get(CONFIG);
  expect(response.ok()).toBe(true);
  const { connectors }: { connectors: StoredOrg[] } = await response.json();
  for (const org of connectors) {
    if (org.myDomain === `https://${PRODUCTION}` || org.myDomain === `https://${UAT}`) {
      const removed = await page.request.delete(`${CONFIG}?key=${encodeURIComponent(org.key)}`);
      expect(removed.ok()).toBe(true);
    }
  }
}

test.beforeEach(async ({ page, person: _person }, testInfo) => {
  test.skip(
    testInfo.project.name !== 'desktop-light',
    'The salesforce connector config is organization-wide: one writer, the dark theme as a screenshot.'
  );
  await removeOwnOrgs(page);
});

test.afterEach(async ({ page, person: _person }, testInfo) => {
  if (testInfo.project.name === 'desktop-light') await removeOwnOrgs(page);
});

test('salesforce: one connector per org — register, narrow a sandbox’s connect, connect', async ({
  page,
  person: _person,
}, testInfo) => {
  test.setTimeout(300_000);

  // --- The operator adds the production org through the form. ---
  await page.route(`**${CONFIG}`, (route) =>
    route.request().method() === 'GET'
      ? route.fulfill({
          json: { connector: 'salesforce', configured: false, enabled: false, connectors: [] },
        })
      : route.fallback()
  );
  await page.goto('/admin/connectors/salesforce');
  await expect(page.getByRole('heading', { name: 'Salesforce', level: 1 })).toBeVisible();
  const form = page.locator('[data-coach="admin-connector-form"]');
  await expect(form.getByText('No Salesforce connectors yet.')).toBeVisible();
  await page.waitForLoadState('networkidle');
  await page.unroute(`**${CONFIG}`);
  await form.getByRole('button', { name: 'Add your production org' }).click();
  await form.locator('#salesforce-new-domain').fill(`https://${PRODUCTION}/lightning/page/home`);
  await form.locator('#salesforce-new-client-id').fill('e2e-sf-client');
  await form.locator('#salesforce-new-client-secret').fill('e2e-sf-secret');
  await form.getByRole('button', { name: 'Save' }).click();
  await expect(form.getByRole('heading', { name: 'Salesforce · Production' })).toBeVisible({
    timeout: 30_000,
  });
  // Stored normalized to the org's origin, and drawn from the reload.
  await expect(form.getByText(`https://${PRODUCTION}`, { exact: true })).toBeVisible();

  // --- A UAT sandbox, put in through the same route, keeping things from the assistant. ---
  const added = await page.request.put(CONFIG, {
    data: {
      name: 'UAT',
      myDomain: UAT,
      sandbox: true,
      clientId: 'e2e-uat-client',
      clientSecret: 'e2e-uat-secret',
      enabled: true,
      scopes: 'sf-records-read sf-records-write sf-reports',
      excludedObjects: 'Case_Note__c',
      excludedFields: 'Contact.Diagnosis__c',
      hideRestricted: true,
    },
  });
  expect(added.ok()).toBe(true);
  await page.reload();
  await expect(form.getByRole('heading', { name: 'Salesforce · UAT' })).toBeVisible();
  await shot(page, testInfo, 'salesforce-01-registered');
  await form.getByRole('button', { name: 'Edit UAT' }).click();
  await expect(form.locator('#salesforce-uat-excluded-objects')).toHaveValue('Case_Note__c');
  await shot(page, testInfo, 'salesforce-01b-kept-away');
  await form.getByRole('button', { name: 'Cancel' }).click();

  // --- The person sees one card per org, and connects the sandbox. ---
  await addConnectors(page.request, ['salesforce']);
  const cards = page.locator('[data-coach="card-salesforce"]').filter({ visible: true });
  // The connectors page reads the config through a cache of its own (a
  // minute in production; zero in the suite, playwright.config.ts).
  await page.goto('/connectors');
  await expect(cards).toHaveCount(2);
  const production = cards.filter({
    has: page.getByRole('heading', { name: /Salesforce · Production/ }),
  });
  const uat = cards.filter({ has: page.getByRole('heading', { name: /Salesforce · UAT/ }) });
  await expect(production.getByText('Not connected')).toBeVisible();
  await expect(production.getByText(PRODUCTION)).toBeVisible();
  await expect(production.getByText('Sandbox', { exact: true })).toHaveCount(0);
  await expect(uat.getByText('Sandbox', { exact: true })).toBeVisible();
  await expect(uat.getByText(UAT)).toBeVisible();

  await uat.getByText(/What Renkei may do/).click();
  // What the org held back is not offered.
  await expect(uat.getByRole('checkbox', { name: /Delete records/ })).toHaveCount(0);
  const connect = uat.getByRole('link', { name: 'Connect Salesforce · UAT' });
  await expect(connect).toHaveAttribute('href', /sf-records-write/);
  await uat.getByRole('checkbox', { name: /Create and update records/ }).uncheck();
  await expect(connect).not.toHaveAttribute('href', /sf-records-write/);
  await shot(page, testInfo, 'salesforce-02-narrowed');
  await page.emulateMedia({ colorScheme: 'dark' });
  await shot(page, testInfo, 'salesforce-02-narrowed-dark');
  await page.emulateMedia({ colorScheme: 'light' });

  // --- Connected to UAT only, through its own link; then the real disconnect. ---
  await connect.click();
  await page.waitForURL(/\/connectors(\?|$)/, { timeout: 30_000 });
  await expect(uat.getByText('Connected', { exact: true })).toBeVisible();
  // The fake Salesforce user, and their username.
  await expect(uat.getByText(/Salesforce user [0-9a-f]{6}/)).toBeVisible();
  await expect(uat.getByText(/\(fake-[0-9a-f]{8}@example\.com\)/)).toBeVisible();
  // What the connect recorded is the narrowed choice, not Salesforce's scopes.
  await expect(uat.getByText(/2 permissions/)).toBeVisible();
  await expect(production.getByText('Not connected')).toBeVisible();
  await shot(page, testInfo, 'salesforce-03-connected');

  await uat.getByRole('button', { name: 'Disconnect Salesforce · UAT' }).click();
  await expect(uat.getByText(/Your other Salesforce connections are not affected/)).toBeVisible();
  await uat.getByRole('button', { name: 'Yes, disconnect' }).click();
  await expect(uat.getByText('Not connected')).toBeVisible({ timeout: 30_000 });
  await page.reload();
  await expect(uat.getByText('Not connected')).toBeVisible();

  // Mobile: a resized Chromium viewport, not a device descriptor.
  await page.setViewportSize(MOBILE_VIEWPORT);
  await expect(uat.getByRole('heading', { name: /Salesforce · UAT/ })).toBeVisible();
  await expect(uat.getByRole('link', { name: 'Connect Salesforce · UAT' })).toBeVisible();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth
  );
  expect(overflow).toBeLessThanOrEqual(0);
  await shot(page, testInfo, 'salesforce-04-mobile');

  // --- The operator's list at a phone's width. ---
  await page.goto('/admin/connectors/salesforce');
  await expect(form.getByRole('heading', { name: 'Salesforce · UAT' })).toBeVisible();
  const overflowAdmin = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth
  );
  expect(overflowAdmin).toBeLessThanOrEqual(0);
  await shot(page, testInfo, 'salesforce-05-admin-mobile');
});
