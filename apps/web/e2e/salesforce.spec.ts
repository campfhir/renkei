/**
 * Salesforce, end to end in a browser, with one connector per org: an
 * operator adds the production org and a UAT sandbox through the real admin
 * list and save route (a login.salesforce.com address is refused — each must
 * be the org's own My Domain), a person finds one card per org on the
 * connectors page, narrows Renkei's capabilities on the sandbox's card, and
 * that connector's authorize route turns it into a PKCE consent request to
 * the sandbox's own My Domain with the sandbox's own consumer key — the
 * fixed Salesforce scopes sent. The person connects the sandbox (its card
 * shows the narrowed capabilities the connect recorded; production stays
 * unconnected) and disconnects it again. Finally the operator removes the
 * sandbox connector and its card goes.
 *
 * Nothing here reaches Salesforce: on the in-memory app the consent is the
 * app's own fake OAuth (packages/provider-grants/src/fake-oauth.ts), whose
 * code carries the request Salesforce would have been sent (read with
 * `fakeConsentRequest`); the delegate trades it for a fake token set naming
 * the sandbox's own instance, and the callback stores the grant as
 * production does.
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
import { addConnectors, fakeConsentRequest } from './support/connectors';
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
  sandbox: boolean;
  clientId: string;
  scopes: string;
  excludedObjects?: string[];
  excludedFields?: string[];
  hideRestricted?: boolean;
}

async function storedConfig(page: Page): Promise<{ enabled: boolean; connectors: StoredOrg[] }> {
  const response = await page.request.get('/api/admin/connectors/salesforce');
  expect(response.ok()).toBe(true);
  return response.json();
}

/** This spec's orgs go, through the route's own DELETE. */
async function removeOwnOrgs(page: Page): Promise<void> {
  const { connectors } = await storedConfig(page);
  for (const org of connectors) {
    if (org.myDomain === `https://${PRODUCTION}` || org.myDomain === `https://${UAT}`) {
      const removed = await page.request.delete(
        `/api/admin/connectors/salesforce?key=${encodeURIComponent(org.key)}`
      );
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

async function addOrg(
  page: Page,
  values: { name?: string; domain: string; clientId: string; secret: string }
): Promise<void> {
  const form = page.locator('[data-coach="admin-connector-form"]');
  if (values.name !== undefined) await form.locator('#salesforce-new-name').fill(values.name);
  await form.locator('#salesforce-new-domain').fill(values.domain);
  await form.locator('#salesforce-new-client-id').fill(values.clientId);
  await form.locator('#salesforce-new-client-secret').fill(values.secret);
  await form.getByRole('button', { name: 'Save' }).click();
}

test('salesforce: one connector per org — register, narrow a sandbox’s connect, remove', async ({
  page,
  person: _person,
}, testInfo) => {
  // Room for the config cache's TTL at the end (see the last step).
  test.setTimeout(300_000);

  // --- The operator adds the production org. ---
  await page.route('**/api/admin/connectors/salesforce', (route) =>
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
  await page.unroute('**/api/admin/connectors/salesforce');
  await form.getByRole('button', { name: 'Add your production org' }).click();
  // The first connector is named Production and is not a sandbox.
  await expect(form.locator('#salesforce-new-name')).toHaveValue('Production');
  await expect(form.getByRole('checkbox', { name: 'This is a sandbox' })).not.toBeChecked();
  // Deleting and reassigning start off; nobody can grant what the org holds back.
  await expect(form.getByRole('checkbox', { name: /Delete records/ })).not.toBeChecked();
  await expect(form.getByRole('checkbox', { name: /Change record owners/ })).not.toBeChecked();

  // The generic login host is refused: it must be the org's own My Domain.
  await addOrg(page, {
    domain: 'login.salesforce.com',
    clientId: 'e2e-sf-client',
    secret: 'e2e-sf-secret',
  });
  // The route's refusal, not the field's hint (which also names login.salesforce.com).
  await expect(form.getByText(/My Domain must be the org’s own/)).toBeVisible({ timeout: 30_000 });
  expect(
    (await storedConfig(page)).connectors.filter((org) => org.clientId === 'e2e-sf-client')
  ).toEqual([]);

  await addOrg(page, {
    domain: `https://${PRODUCTION}/lightning/page/home`,
    clientId: 'e2e-sf-client',
    secret: 'e2e-sf-secret',
  });
  await expect(form.getByRole('heading', { name: 'Salesforce · Production' })).toBeVisible({
    timeout: 30_000,
  });
  // Stored normalized to the org's origin.
  await expect(form.getByText(`https://${PRODUCTION}`, { exact: true })).toBeVisible();

  // --- Then a UAT sandbox: its own connector, its own app. ---
  await form.getByRole('button', { name: 'Add a Salesforce org' }).click();
  await expect(form.getByRole('checkbox', { name: 'This is a sandbox' })).toBeChecked();
  // Two connectors cannot share an org.
  await addOrg(page, {
    name: 'UAT',
    domain: PRODUCTION,
    clientId: 'e2e-uat-client',
    secret: 'e2e-uat-secret',
  });
  await expect(form.getByText(/is already the Production connector/)).toBeVisible({
    timeout: 30_000,
  });
  await addOrg(page, {
    name: 'UAT',
    domain: UAT,
    clientId: 'e2e-uat-client',
    secret: 'e2e-uat-secret',
  });
  await expect(form.getByRole('heading', { name: 'Salesforce · UAT' })).toBeVisible({
    timeout: 30_000,
  });
  await shot(page, testInfo, 'salesforce-01-registered');

  // Editing keeps the stored secret when the field is left blank — and
  // this is where the org keeps objects and fields away from the assistant.
  await form.getByRole('button', { name: 'Edit UAT' }).click();
  await expect(form.locator('#salesforce-uat-client-secret')).toHaveAttribute(
    'placeholder',
    'Stored — leave blank to keep'
  );
  await form.locator('#salesforce-uat-excluded-objects').fill('Case_Note__c');
  // A field without its object is refused by the route.
  await form.locator('#salesforce-uat-excluded-fields').fill('Diagnosis__c');
  await form.getByRole('button', { name: 'Save' }).click();
  await expect(form.getByText(/Hidden fields are Object\.Field API names/)).toBeVisible({
    timeout: 30_000,
  });
  await form.locator('#salesforce-uat-excluded-fields').fill('Contact.Diagnosis__c');
  await form
    .getByRole('checkbox', { name: /Hide every field this org.s data classification/ })
    .check();
  await shot(page, testInfo, 'salesforce-01b-kept-away');
  await form.getByRole('button', { name: 'Save' }).click();
  await expect(
    form.getByText(
      'Case_Note__c (object), Contact.Diagnosis__c, fields classified Restricted or Mission Critical'
    )
  ).toBeVisible({ timeout: 30_000 });

  const stored = await storedConfig(page);
  expect(stored.enabled).toBe(true);
  const orgs = stored.connectors;
  expect(orgs.map((org) => [org.key, org.myDomain, org.sandbox, org.clientId])).toEqual([
    ['production', `https://${PRODUCTION}`, false, 'e2e-sf-client'],
    ['uat', `https://${UAT}`, true, 'e2e-uat-client'],
  ]);
  expect(orgs[1]?.scopes.split(' ').sort()).toEqual(
    ['sf-records-read', 'sf-records-write', 'sf-reports'].sort()
  );
  expect([orgs[1]?.excludedObjects, orgs[1]?.excludedFields, orgs[1]?.hideRestricted]).toEqual([
    ['Case_Note__c'],
    ['Contact.Diagnosis__c'],
    true,
  ]);
  expect(orgs[0]?.hideRestricted).toBe(false);

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

  // The sandbox's authorize route asks the sandbox's own My Domain, with its
  // own consumer key, PKCE and Salesforce's fixed scopes; the narrowing and
  // the connector stay with Renkei (the connected card shows them below).
  const href = await connect.getAttribute('href');
  expect(href).toMatch(/^\/api\/salesforce\/uat\/authorize/);
  const authorize = await page.request.get(href ?? '', { maxRedirects: 0 });
  expect([302, 307]).toContain(authorize.status());
  const consent = fakeConsentRequest(authorize.headers()['location'] ?? '');
  expect(consent.origin + consent.pathname).toBe(`https://${UAT}/services/oauth2/authorize`);
  expect(consent.searchParams.get('client_id')).toBe('e2e-uat-client');
  expect(consent.searchParams.get('scope')).toBe('api refresh_token id');
  expect(consent.searchParams.get('code_challenge_method')).toBe('S256');
  expect(consent.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(consent.searchParams.get('state')).toBeTruthy();

  // A capability beyond the connector's ceiling is refused, not silently
  // dropped; so is a connector that does not exist.
  const widened = await page.request.get(
    '/api/salesforce/uat/authorize?scopes=sf-records-read+sf-records-delete',
    { maxRedirects: 0 }
  );
  expect(widened.status()).toBe(400);
  const unknown = await page.request.get('/api/salesforce/full-copy/authorize', {
    maxRedirects: 0,
  });
  expect(unknown.status()).toBe(503);

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

  // --- The operator removes the sandbox connector; its card goes. ---
  await page.goto('/admin/connectors/salesforce');
  await form.getByRole('button', { name: 'Edit UAT' }).click();
  await form.getByRole('button', { name: 'Remove this connector' }).click();
  await form.getByRole('button', { name: 'Yes, remove' }).click();
  await expect(form.getByRole('heading', { name: 'Salesforce · UAT' })).toHaveCount(0, {
    timeout: 30_000,
  });
  await expect(form.getByRole('heading', { name: 'Salesforce · Production' })).toBeVisible();
  const overflowAdmin = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth
  );
  expect(overflowAdmin).toBeLessThanOrEqual(0);
  await shot(page, testInfo, 'salesforce-05-admin-mobile');
  await page.goto('/connectors');
  await expect(cards).toHaveCount(1);
  await expect(cards.getByRole('heading', { name: /Salesforce · Production/ })).toBeVisible();
});
