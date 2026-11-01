/**
 * Salesforce Admin, end to end in a browser, up to Salesforce itself.
 *
 * An operator adds a UAT sandbox through the real admin form and save
 * route (the form's one press-through); production, left read only, is
 * put in through the same route. A person sees one admin card per org and
 * connects the sandbox through its link — the operator's one real OAuth
 * walk.
 *
 * Then someone without approving rights connects the sandbox too (needed
 * for the tool's grant) and asks for a change in words — a real chat turn
 * on the stub model, calling salesforce_admin_request_change — and the
 * request's review pages follow: the operator's list and card count, the
 * request's text and requester, the asker's own list, and their
 * withdrawing it (the actions' one press-through), at a phone's width too.
 *
 * Where the rules went:
 * - the form's defaults (building starts in a sandbox; no kept-away
 *   lists; production takes no change requests until allowed), the
 *   summary lines and what Save sends: salesforce-form.model.test.ts
 *   beside app/(app)/admin/connectors/forms/salesforce-form.tsx;
 * - the stored orgs and the admin ceiling (user access off unless
 *   chosen): app/api/admin/connectors/salesforce/route.test.ts;
 * - the authorize redirect's query (the org's own My Domain, its own
 *   consumer key, PKCE): app/api/salesforce/[connector]/authorize/route.test.ts;
 * - which actions a person sees by role and state (nothing to approve on
 *   a request in words, only Withdraw for the asker, the operator's
 *   note): change-actions.model.test.ts beside
 *   app/(app)/salesforce-admin/changes/[changeId]/change-actions.tsx;
 * - the routes holding the line (approve is an operator's alone, 403; a
 *   request in words has nothing to approve, 409; withdraw and decline):
 *   app/api/salesforce-admin/changes/[changeId]/apply/route.test.ts.
 *
 * Connects are the in-memory app's fake OAuth
 * (packages/provider-grants/src/fake-oauth.ts): the consent answers at
 * once with a code, and the callback stores the grant as production does.
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
import { addConnectors, connectThrough } from './support/connectors';
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
  await form.locator('#salesforce-admin-new-name').fill('UAT');
  await form.locator('#salesforce-admin-new-domain').fill(UAT);
  await form.locator('#salesforce-admin-new-client-id').fill('e2e-admin-uat-client');
  await form.locator('#salesforce-admin-new-client-secret').fill('e2e-admin-uat-client-secret');
  await form.getByRole('button', { name: 'Save' }).click();
  await expect(form.getByRole('heading', { name: 'Salesforce Admin · UAT' })).toBeVisible({
    timeout: 30_000,
  });

  // Production, read only, through the same route.
  const added = await page.request.put(CONFIG, {
    data: {
      name: 'Production',
      myDomain: PRODUCTION,
      sandbox: false,
      clientId: 'e2e-admin-production-client',
      clientSecret: 'e2e-admin-production-client-secret',
      enabled: true,
      productionChanges: false,
    },
  });
  expect(added.ok()).toBe(true);
  await page.reload();
  await expect(form.getByRole('heading', { name: 'Salesforce Admin · Production' })).toBeVisible();
  await shot(page, testInfo, 'salesforce-admin-01-registered');

  // --- The person's cards: one per org, and the sandbox's connect link. ---
  await addConnectors(page.request, ['salesforce-admin']);
  const cards = page.locator('[data-coach="card-salesforce-admin"]').filter({ visible: true });
  // The suite runs with the config cache off (RENKEI_CONFIG_CACHE_TTL_MS=0,
  // e2e/server-env.ts), so the page reads both orgs as just saved.
  await page.goto('/connectors');
  await expect(cards).toHaveCount(2);
  const uat = cards.filter({ has: page.getByRole('heading', { name: /Salesforce Admin · UAT/ }) });
  await expect(uat.getByText('Sandbox', { exact: true })).toBeVisible();
  const connectLink = uat.getByRole('link', { name: 'Connect Salesforce Admin · UAT' });
  await expect(connectLink).toHaveAttribute('href', /^\/api\/salesforce-admin\/uat\/authorize/);

  // --- Connected to the sandbox, through its link. ---
  await connectLink.click();
  await page.waitForURL(/\/connectors(\?|$)/, { timeout: 30_000 });
  const production = cards.filter({
    has: page.getByRole('heading', { name: /Salesforce Admin · Production/ }),
  });
  await expect(uat.getByText('Connected', { exact: true })).toBeVisible();
  await expect(production.getByText('Not connected')).toBeVisible();
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
    await expect(page.getByRole('button', { name: 'Decline it' })).toBeVisible();
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
    await expect(askerPage.getByRole('button', { name: 'Withdraw it' })).toBeVisible();
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
