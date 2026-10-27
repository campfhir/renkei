/**
 * Salesforce Admin, end to end in a browser, up to the consent redirect.
 *
 * An operator adds two admin connectors through the real admin form and
 * save route: a UAT sandbox, and production with change requests left off
 * (the safe default). A person sees one admin card per org, and the
 * sandbox's connect link turns into a PKCE consent redirect to its own My
 * Domain with its own consumer key.
 *
 * Not reachable here, and covered elsewhere: the connected cards, and the
 * change requests and their review pages (validated, failed, access,
 * picklist, production-gated, the list, cancel, decline, asking without
 * approving rights, a running deploy). A connected card is a grant the
 * OAuth callback writes after a code exchange with the org's My Domain,
 * made server-side; a change request is a row only a
 * salesforce_admin_propose_* tool writes, after Salesforce's check-only
 * deploy, through that same grant. The pending sign-in row's provider and
 * connector key are not read back by any route either. The review pages'
 * rendering is unit-tested beside lib/salesforce-admin; the deploy itself
 * by lib/salesforce-admin/apply.test.ts against a fake org.
 *
 * Connector configs are organization-wide: the `salesforce-admin` row is
 * this spec's alone on the server, its two orgs are removed again through
 * the route's own DELETE ?key= before and after, and the flow runs once, in
 * desktop-light, with the dark theme as an `emulateMedia` screenshot. The
 * empty list it starts from is the config's GET answered empty at the
 * browser edge.
 *
 * Runs on the pinned Chromium only; "mobile" is a resized viewport, per AGENTS.md.
 */

import path from 'node:path';
import type { Page, TestInfo } from '@playwright/test';
import { addConnectors } from '../support/connectors';
import { test, expect } from './fixtures';

const RESULTS = path.join(import.meta.dirname, '..', '..', 'test-results', 'memory');
const MOBILE_VIEWPORT = { width: 390, height: 844 };
const PRODUCTION = 'acme-e2e-admin.my.salesforce.com';
const UAT = 'acme-e2e-admin--uat.sandbox.my.salesforce.com';
const CONFIG = '/api/admin/connectors/salesforce-admin';

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
  sandbox: boolean;
  productionChanges?: boolean;
  scopes: string;
}

async function storedOrgs(page: Page): Promise<StoredOrg[]> {
  const response = await page.request.get(CONFIG);
  expect(response.ok()).toBe(true);
  const body: { connectors: StoredOrg[] } = await response.json();
  return body.connectors;
}

/** This spec's orgs go, through the route's own DELETE. */
async function removeOwnOrgs(page: Page): Promise<void> {
  for (const org of await storedOrgs(page)) {
    if (org.myDomain === `https://${PRODUCTION}` || org.myDomain === `https://${UAT}`) {
      const removed = await page.request.delete(`${CONFIG}?key=${encodeURIComponent(org.key)}`);
      expect(removed.ok()).toBe(true);
    }
  }
}

test.beforeEach(async ({ page, person: _person }, testInfo) => {
  test.skip(
    testInfo.project.name !== 'desktop-light',
    'The salesforce-admin connector config is organization-wide: one writer, the dark theme as a screenshot.'
  );
  await removeOwnOrgs(page);
});

test.afterEach(async ({ page, person: _person }, testInfo) => {
  if (testInfo.project.name === 'desktop-light') await removeOwnOrgs(page);
});

async function addOrg(
  page: Page,
  values: { name: string; domain: string; clientId: string; sandbox: boolean }
): Promise<void> {
  const form = page.locator('[data-coach="admin-connector-form"]');
  await form.locator('#salesforce-admin-new-name').fill(values.name);
  await form.locator('#salesforce-admin-new-domain').fill(values.domain);
  const sandbox = form.getByRole('checkbox', { name: 'This is a sandbox' });
  if ((await sandbox.isChecked()) !== values.sandbox) await sandbox.click();
  await form.locator('#salesforce-admin-new-client-id').fill(values.clientId);
  await form.locator('#salesforce-admin-new-client-secret').fill(`${values.clientId}-secret`);
  await form.getByRole('button', { name: 'Save' }).click();
}

test('salesforce admin: per-org connectors and the sandbox’s consent redirect', async ({
  page,
  person: _person,
}, testInfo) => {
  test.setTimeout(180_000);

  // --- The operator adds a sandbox to build in, and production left read only. ---
  await page.route(`**${CONFIG}`, (route) =>
    route.request().method() === 'GET'
      ? route.fulfill({
          json: {
            connector: 'salesforce-admin',
            configured: false,
            enabled: false,
            connectors: [],
          },
        })
      : route.fallback()
  );
  await page.goto('/admin/connectors/salesforce-admin');
  await expect(page.getByRole('heading', { name: 'Salesforce Admin', level: 1 })).toBeVisible();
  const form = page.locator('[data-coach="admin-connector-form"]');
  await expect(form.getByText('No Salesforce Admin connectors yet.')).toBeVisible();
  await page.waitForLoadState('networkidle');
  await page.unroute(`**${CONFIG}`);
  await form.getByRole('button', { name: 'Add your first org' }).click();
  // Building usually starts in a sandbox.
  await expect(form.getByRole('checkbox', { name: 'This is a sandbox' })).toBeChecked();
  // The CRM's "kept away" fields are not the admin connector's.
  await expect(form.getByText('Kept away from the assistant')).toHaveCount(0);
  await addOrg(page, { name: 'UAT', domain: UAT, clientId: 'e2e-admin-uat-client', sandbox: true });
  await expect(form.getByRole('heading', { name: 'Salesforce Admin · UAT' })).toBeVisible({
    timeout: 30_000,
  });
  await expect(form.getByText('Applied here when the person approves them')).toBeVisible();

  await form.getByRole('button', { name: 'Add a Salesforce org' }).click();
  await form.getByRole('checkbox', { name: 'This is a sandbox' }).uncheck();
  // Production takes no change requests until an admin says so.
  const allow = form.getByRole('checkbox', {
    name: /Allow change requests in this production org/,
  });
  await expect(allow).not.toBeChecked();
  await addOrg(page, {
    name: 'Production',
    domain: PRODUCTION,
    clientId: 'e2e-admin-production-client',
    sandbox: false,
  });
  await expect(form.getByRole('heading', { name: 'Salesforce Admin · Production' })).toBeVisible({
    timeout: 30_000,
  });
  await expect(form.getByText('Not in this production org — read only')).toBeVisible();
  await shot(page, testInfo, 'salesforce-admin-01-registered');

  const stored = await storedOrgs(page);
  expect(stored.map((org) => [org.key, org.sandbox, org.productionChanges])).toEqual([
    ['uat', true, false],
    ['production', false, false],
  ]);
  // User access (assigning permission sets to people) is off unless chosen.
  expect(stored[0]?.scopes.split(' ').sort()).toEqual([
    'sfa-layouts',
    'sfa-permissions',
    'sfa-read',
    'sfa-schema',
  ]);

  // --- The person's cards: one per org, and the sandbox's connect link. ---
  await addConnectors(page.request, ['salesforce-admin']);
  const cards = page.locator('[data-coach="card-salesforce-admin"]');
  // The connectors page reads the config through a 60-second cache
  // (@renkei/connector-config) that a save in another module instance does
  // not clear: a run soon after the last one may first see its leftovers.
  await expect(async () => {
    await page.goto('/connectors');
    await expect(cards).toHaveCount(2, { timeout: 2_000 });
  }).toPass({ timeout: 90_000, intervals: [5_000] });
  const uat = cards.filter({ has: page.getByRole('heading', { name: /Salesforce Admin · UAT/ }) });
  await expect(uat.getByText('Sandbox', { exact: true })).toBeVisible();
  const connectLink = uat.getByRole('link', { name: 'Connect Salesforce Admin · UAT' });
  const href = await connectLink.getAttribute('href');
  expect(href).toMatch(/^\/api\/salesforce-admin\/uat\/authorize/);
  const authorize = await page.request.get(href ?? '', { maxRedirects: 0 });
  expect([302, 307]).toContain(authorize.status());
  const consent = new URL(authorize.headers()['location'] ?? '');
  expect(consent.origin + consent.pathname).toBe(`https://${UAT}/services/oauth2/authorize`);
  expect(consent.searchParams.get('client_id')).toBe('e2e-admin-uat-client');
  expect(consent.searchParams.get('code_challenge_method')).toBe('S256');
  expect(consent.searchParams.get('state')).toBeTruthy();
  await shot(page, testInfo, 'salesforce-admin-02-cards');
  await page.emulateMedia({ colorScheme: 'dark' });
  await shot(page, testInfo, 'salesforce-admin-02-cards-dark');
  await page.emulateMedia({ colorScheme: 'light' });

  // Mobile: a resized Chromium viewport.
  await page.setViewportSize(MOBILE_VIEWPORT);
  await expect(connectLink).toBeVisible();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth
  );
  expect(overflow).toBeLessThanOrEqual(0);
  await shot(page, testInfo, 'salesforce-admin-03-cards-mobile');
});
