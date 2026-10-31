/**
 * Salesforce Admin, end to end in a browser, up to Salesforce itself.
 *
 * An operator adds two admin connectors through the real admin form and
 * save route: a UAT sandbox, and production with change requests left off
 * (the safe default). A person sees one admin card per org, the sandbox's
 * connect link asks for a PKCE consent at its own My Domain with its own
 * consumer key, and they connect both: the production card says it is read
 * only here.
 *
 * Then someone without approving rights connects the sandbox too and asks
 * for a change in words — a real chat turn on the stub model, calling
 * salesforce_admin_request_change — and the request's review pages follow:
 * the operator's list and card count, the request with nothing to approve
 * (only to build or decline, and the apply route refusing it), the
 * asker's own list, and their withdrawing it.
 *
 * Connects are the in-memory app's fake OAuth
 * (packages/provider-grants/src/fake-oauth.ts): the consent answers at once
 * with a code carrying the request Salesforce would have been sent (read
 * with `fakeConsentRequest`), and the callback stores the grant as
 * production does.
 *
 * Not reachable here: the proposals (validated, failed, access, picklist,
 * production-gated) and a running deploy. A salesforce_admin_propose_* tool
 * reads the org's live metadata and runs Salesforce's check-only deploy
 * through the grant, server-side, at the org's own My Domain — which the
 * delegate lets an admin token reach and nothing else; no stand-in for
 * Salesforce's API exists, and one that answers describes, SOQL and the
 * Metadata API's deploys is not a small addition. The review pages'
 * rendering of proposals is unit-tested beside lib/salesforce-admin, the
 * deploy itself by lib/salesforce-admin/apply.test.ts against a fake org.
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

import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { Page, TestInfo } from '@playwright/test';
import { askAndWait, createChat } from './support/code-host';
import { addConnectors, connectThrough, fakeConsentRequest } from './support/connectors';
import { createPerson, signIn } from './support/person';
import { addStubModel, toolStep, removeModel, scripted } from './support/stub-model';
import { test, expect } from './fixtures';

const RESULTS = path.join(import.meta.dirname, '..', 'test-results');
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

test('salesforce admin: per-org connectors, connect, and a change asked for in words', async ({
  browser,
  page,
  request,
  person: _person,
}, testInfo) => {
  test.setTimeout(300_000);

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
  const cards = page.locator('[data-coach="card-salesforce-admin"]').filter({ visible: true });
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
  const consent = fakeConsentRequest(authorize.headers()['location'] ?? '');
  expect(consent.origin + consent.pathname).toBe(`https://${UAT}/services/oauth2/authorize`);
  expect(consent.searchParams.get('client_id')).toBe('e2e-admin-uat-client');
  expect(consent.searchParams.get('code_challenge_method')).toBe('S256');
  expect(consent.searchParams.get('state')).toBeTruthy();

  // --- Connected to both: the sandbox through its link, production too. ---
  await connectLink.click();
  await page.waitForURL(/\/connectors(\?|$)/, { timeout: 30_000 });
  await connectThrough(page, '/api/salesforce-admin/production/authorize');
  const production = cards.filter({
    has: page.getByRole('heading', { name: /Salesforce Admin · Production/ }),
  });
  await expect(uat.getByText('Connected', { exact: true })).toBeVisible();
  await expect(production.getByText('Connected', { exact: true })).toBeVisible();
  await expect(production.getByText('This production org is read only here')).toBeVisible();
  await shot(page, testInfo, 'salesforce-admin-02-cards');
  await page.emulateMedia({ colorScheme: 'dark' });
  await shot(page, testInfo, 'salesforce-admin-02-cards-dark');
  await page.emulateMedia({ colorScheme: 'light' });

  // Mobile: a resized Chromium viewport.
  await page.setViewportSize(MOBILE_VIEWPORT);
  await expect(uat.getByRole('heading', { name: /Salesforce Admin · UAT/ })).toBeVisible();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth
  );
  expect(overflow).toBeLessThanOrEqual(0);
  await shot(page, testInfo, 'salesforce-admin-03-cards-mobile');
  await page.setViewportSize({ width: 1440, height: 900 });

  // --- Asking without approving rights: a request in words, from a chat. ---
  const modelId = await addStubModel(
    page.request,
    `sfa-${testInfo.project.name}-${randomUUID().slice(0, 6)}`
  );
  // Its own request context: signing in sets the session cookie where it is sent.
  const asker = await createPerson(request, { displayName: 'Arlo Asker' });
  const askerContext = await browser.newContext({ reducedMotion: 'reduce' });
  try {
    await signIn(askerContext, asker);
    const askerPage = await askerContext.newPage();
    await addConnectors(askerPage.request, ['salesforce-admin']);
    await connectThrough(askerPage, '/api/salesforce-admin/uat/authorize');
    const chatId = await createChat(askerPage.request, { llmModelId: modelId });
    // Change requests are the org's (one UAT for the whole server): this
    // run's own is told apart by its title.
    const title = `Add an Outcome picklist to Site Visit ${randomUUID().slice(0, 6)}`;
    const input = {
      title,
      description: 'Site_Visit__c needs Outcome__c: Completed, No show.',
      reason: 'The program tracks outcomes now',
    };
    await askAndWait(askerPage.request, chatId, {
      text: scripted('Please ask for this.', [toolStep('salesforce_admin_request_change', input)]),
      llmModelId: modelId,
    });

    // The operator: the request waiting, counted on the sandbox's card.
    await page.goto('/connectors');
    await expect(
      uat.getByRole('link', { name: /^\d+ change requests? waiting for review$/ })
    ).toBeVisible();
    await page.goto('/salesforce-admin/changes');
    await expect(page.getByRole('heading', { name: 'Salesforce admin changes' })).toBeVisible();
    const waiting = page
      .getByRole('main')
      .getByTestId('changes-waiting')
      .getByRole('link', { name: new RegExp(title) });
    await expect(waiting).toHaveCount(1);
    await shot(page, testInfo, 'salesforce-admin-05-list');

    // A request in words: what was asked, and nothing to approve — only to build or decline.
    await waiting.click();
    await expect(page.getByRole('main').getByTestId('change-request-text')).toContainText(
      'Site_Visit__c needs Outcome__c: Completed, No show.',
      { timeout: 30_000 }
    );
    await expect(page.getByRole('main').getByTestId('change-requester')).toContainText(
      'Arlo Asker'
    );
    await expect(page.getByRole('button', { name: /Approve/ })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Decline it' })).toBeVisible();
    const requestId = new URL(page.url()).pathname.split('/').pop() ?? '';
    const words = await page.request.post(`/api/salesforce-admin/changes/${requestId}/apply`);
    expect(words.status()).toBe(409);
    await shot(page, testInfo, 'salesforce-admin-06-request');

    // The person who asked: their request waits for an operator, nothing to approve.
    await askerPage.goto('/salesforce-admin/changes');
    await expect(askerPage.getByRole('heading', { name: 'Waiting for an operator' })).toBeVisible();
    const own = askerPage.getByRole('main').getByTestId('changes-waiting').getByRole('link');
    await expect(own).toHaveCount(1);
    await askerPage.screenshot({
      path: path.join(
        RESULTS,
        'screens',
        testInfo.project.name,
        'salesforce-admin-08-asker-list.png'
      ),
      fullPage: true,
    });
    await own.click();
    await expect(askerPage.getByRole('main').getByTestId('change-request-text')).toBeVisible({
      timeout: 30_000,
    });
    await expect(askerPage.getByRole('main').getByTestId('change-requester')).toContainText(
      'by you'
    );
    await expect(askerPage.getByRole('button', { name: /Approve|Decline/ })).toHaveCount(0);
    await expect(askerPage.getByRole('button', { name: 'Withdraw it' })).toBeVisible();
    await expect(
      askerPage.getByText(/An operator reviews and approves changes to UAT/)
    ).toBeVisible();
    // The route holds the line, whatever the page shows.
    const notAllowed = await askerPage.request.post(
      `/api/salesforce-admin/changes/${requestId}/apply`
    );
    expect([403, 409]).toContain(notAllowed.status());
    await askerPage.setViewportSize(MOBILE_VIEWPORT);
    expect(
      await askerPage.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth
      )
    ).toBeLessThanOrEqual(0);
    await askerPage.screenshot({
      path: path.join(
        RESULTS,
        'screens',
        testInfo.project.name,
        'salesforce-admin-10-asker-review-mobile.png'
      ),
      fullPage: true,
    });
    await askerPage.setViewportSize({ width: 1280, height: 900 });

    // They withdraw it.
    await askerPage.getByRole('button', { name: 'Withdraw it' }).click();
    await expect(askerPage.getByRole('main').getByTestId('change-state')).toHaveText('Cancelled', {
      timeout: 30_000,
    });
    // And the operator's list has it among the recent, no longer waiting.
    await page.goto('/salesforce-admin/changes');
    await expect(
      page
        .getByRole('main')
        .getByTestId('changes-recent')
        .getByRole('link', { name: new RegExp(title) })
    ).toHaveCount(1);
    await expect(waiting).toHaveCount(0);
  } finally {
    await askerContext.close();
    await removeModel(page.request, modelId);
  }
});
