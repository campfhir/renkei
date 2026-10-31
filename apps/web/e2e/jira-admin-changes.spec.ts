/**
 * Jira admin change requests, end to end in a browser: a proposal waits on
 * the review page until its owner applies it, and applying runs the stored
 * operations against Jira — here the stand-in in e2e/sandbox-stub.mjs,
 * which the app reaches through JIRA_ADMIN_API_BASE_URL, so nothing leaves
 * this machine.
 *
 * The person connects Jira Administration through its real connect flow
 * (the in-memory app's fake OAuth, e2e/support/jira-admin.ts) and their
 * assistant proposes: a chat turn on the stand-in model calling
 * jira_admin_propose_option_changes, which reads the field, its contexts
 * and their options from the stand-in Jira (its "Source" select list, with
 * a context of OPS's own and a global one).
 *
 * Then the refusals, each of which must leave the request pending and
 * Jira untouched: a connection without the scope the writes need (the
 * person reconnects with a narrower choice), a proposal for another Jira
 * site (someone else's, made in theirs), and that request before a person
 * who is not an operator. And a proposal Jira moved
 * underneath — an option added by hand since — stops at that operation
 * and runs nothing after it.
 *
 * Not reachable here: an expired proposal (requests live a day, and
 * nothing moves the server's clock). The audit trail's row is not read back: no
 * page lists it.
 *
 * Each person works in a Jira site of their own, so the stub's options
 * start fresh for every test. An operator sees everyone's requests, and
 * every project shares the server: assertions are scoped to this test's
 * own requests, by id.
 *
 * Pinned Chromium; "mobile" is a resized viewport, per AGENTS.md.
 */

import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { Page, TestInfo } from '@playwright/test';
import {
  connectJiraAdministration,
  fakeJiraSite,
  JIRA_STUB,
  prepareJiraAdministration,
  proposeInChat,
} from './support/jira-admin';
import { createPerson, signIn } from './support/person';
import { addStubModel, removeModel } from './support/stub-model';
import { test, expect } from './fixtures';

const RESULTS = path.join(import.meta.dirname, '..', 'test-results');
const MOBILE_VIEWPORT = { width: 390, height: 844 };
const FIELD_ID = 'customfield_10100';
const CONTEXT_ID = '10200';

test.use({ roles: ['renkei-user', 'renkei-operator'] });

/** What the stand-in Jira holds for the field's OPS context now. */
async function liveOptions(subject: string): Promise<string[]> {
  const response = await fetch(
    `${JIRA_STUB}/${fakeJiraSite(subject).cloudId}/rest/api/3/field/${FIELD_ID}/context/${CONTEXT_ID}/option`
  );
  const body: unknown = await response.json();
  const values: unknown[] =
    typeof body === 'object' && body !== null && 'values' in body && Array.isArray(body.values)
      ? body.values
      : [];
  return values.map((option) => {
    const record: Record<string, unknown> =
      typeof option === 'object' && option !== null
        ? Object.fromEntries(Object.entries(option))
        : {};
    return `${String(record.value)}${record.disabled === true ? ' (disabled)' : ''}`;
  });
}

async function shot(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  await page.screenshot({
    path: path.join(RESULTS, 'screens', testInfo.project.name, `${name}.png`),
    fullPage: true,
  });
}

/**
 * The page's own content. Test ids are looked up inside it: right after a
 * full load, React can still hold a hidden copy of a streamed segment
 * outside <main> (role queries skip hidden nodes; test ids do not).
 */
function main(page: Page) {
  return page.getByRole('main');
}

async function noHorizontalOverflow(page: Page): Promise<void> {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth
  );
  expect(overflow).toBeLessThanOrEqual(0);
}

let modelId = '';

test.beforeEach(async ({ page, request, person: _person }, testInfo) => {
  await prepareJiraAdministration(request);
  await connectJiraAdministration(page);
  modelId = await addStubModel(
    page.request,
    `jira-changes-${testInfo.project.name}-${randomUUID().slice(0, 6)}`
  );
});

test.afterEach(async ({ page }) => {
  if (modelId) await removeModel(page.request, modelId);
  modelId = '';
});

test('a proposal waits for review, and applying it changes Jira exactly as shown', async ({
  page,
  person,
}, testInfo) => {
  // --- Nothing proposed yet: the list is there, the field untouched. ---
  await page.goto(`/jira-admin/changes`);
  await expect(page.getByRole('heading', { name: 'Jira admin changes', level: 1 })).toBeVisible();
  expect(await liveOptions(person.subject)).toEqual(['Customer', 'Partner', 'Legacy']);
  await shot(page, testInfo, 'jira-admin-changes-01-empty');

  // --- A proposal arrives, from the person's assistant. ---
  const id = await proposeInChat(page, modelId, 'jira_admin_propose_option_changes', {
    field: 'Source',
    space: 'OPS',
    add: ['Vendor'],
    rename: [{ from: 'Partner', to: 'Channel partner' }],
    disable: ['Legacy'],
    move: { options: ['Vendor'], position: 'first' },
    reason: 'Procurement tags vendor tickets from Monday',
  });
  const own = (where: Page) => main(where).locator(`a[href$="/jira-admin/changes/${id}"]`);

  // The Connectors page says how many wait — everyone's, for an operator,
  // and other specs share the server — and leads to them.
  await page.goto(`/connectors`);
  const card = page.locator('[data-coach="card-jira-admin"]').filter({ visible: true });
  const waiting = card.getByTestId('jira-admin-changes-link');
  await expect(waiting).toHaveText(/^\d+ proposed changes? waiting for review$/);
  // Client-side navigations: on a cold `next dev` a route compiles on its
  // first visit, past the default 5s wait.
  await waiting.click();
  await expect(page).toHaveURL(new RegExp(`/jira-admin/changes$`), { timeout: 30_000 });
  await main(page).getByTestId('changes-waiting').locator(`a[href$="/${id}"]`).click();
  await expect(page).toHaveURL(new RegExp(`/jira-admin/changes/${id}$`), { timeout: 30_000 });

  // --- The review page: every operation, where, why. ---
  await expect(page.getByRole('heading', { name: 'Review a Jira admin change' })).toBeVisible();
  await expect(main(page).getByTestId('change-state')).toHaveText('Waiting for review');
  await expect(main(page).getByTestId('change-reach')).toHaveText(
    'Where: The context “Ops context”, used by OPS.'
  );
  await expect(main(page).getByText('Procurement tags vendor tickets from Monday')).toBeVisible();
  const operations = main(page).getByTestId('change-operations').getByRole('listitem');
  await expect(operations).toHaveText([
    'Add option “Vendor”',
    'Rename “Partner” to “Channel partner”',
    'Disable “Legacy”',
    'Move “Vendor” to the top',
  ]);
  // Nothing has reached Jira yet.
  expect(await liveOptions(person.subject)).toEqual(['Customer', 'Partner', 'Legacy']);
  await shot(page, testInfo, 'jira-admin-changes-02-review');

  // --- Apply: the stored operations run, in order, against Jira. ---
  await page.getByRole('button', { name: 'Apply these 4 changes to Jira' }).click();
  await expect(main(page).getByTestId('change-state')).toHaveText('Applied', { timeout: 30_000 });
  await expect(page.getByRole('heading', { name: 'What happened' })).toBeVisible();
  await expect(operations.getByText('Done', { exact: true })).toHaveCount(4);
  await expect(page.getByRole('button', { name: /Apply/ })).toHaveCount(0);
  expect(await liveOptions(person.subject)).toEqual([
    'Vendor',
    'Customer',
    'Channel partner',
    'Legacy (disabled)',
  ]);
  await shot(page, testInfo, 'jira-admin-changes-03-applied');

  // Applying twice is refused — the route, not only the missing button.
  const again = await page.request.post(`/api/jira-admin/changes/${id}/apply`);
  expect(again.status()).toBe(409);

  // The list now files it under Recent.
  await page.goto(`/jira-admin/changes`);
  await expect(main(page).getByTestId('changes-waiting').locator(`a[href$="/${id}"]`)).toHaveCount(
    0
  );
  await expect(page.getByRole('heading', { name: 'Recent' })).toBeVisible();
  await expect(own(page).getByTestId('change-state')).toHaveText('Applied');

  // Mobile: a resized Chromium viewport, not a device descriptor.
  await page.setViewportSize(MOBILE_VIEWPORT);
  await noHorizontalOverflow(page);
  await page.goto(`/jira-admin/changes/${id}`);
  await expect(main(page).getByTestId('change-title')).toBeVisible();
  await noHorizontalOverflow(page);
  await shot(page, testInfo, 'jira-admin-changes-04-mobile');
});

test('a stale or refused proposal changes nothing, and says why', async ({
  browser,
  page,
  request,
  person,
}, testInfo) => {
  test.setTimeout(180_000);
  const cloudId = fakeJiraSite(person.subject).cloudId;

  // --- Jira moved underneath: an option this renames was renamed by hand since. ---
  const stale = await proposeInChat(page, modelId, 'jira_admin_propose_option_changes', {
    field: 'Source',
    space: 'OPS',
    add: ['Vendor'],
    rename: [{ from: 'Partner', to: 'Reseller' }],
    disable: ['Legacy'],
  });
  const renamed = await fetch(
    `${JIRA_STUB}/${cloudId}/rest/api/3/field/${FIELD_ID}/context/${CONTEXT_ID}/option`,
    {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ options: [{ id: '10002', value: 'Channel partner' }] }),
    }
  );
  expect(renamed.ok).toBe(true);
  await page.goto(`/jira-admin/changes/${stale}`);
  const results = main(page).getByTestId('change-operations').getByRole('listitem');
  await expect(results).toHaveCount(3);
  await page.getByRole('button', { name: 'Apply these 3 changes to Jira' }).click();
  await expect(main(page).getByTestId('change-state')).toHaveText('Partly applied', {
    timeout: 30_000,
  });
  // The add ran; the rename stops where Jira moved, and the disable after it does not run.
  await expect(results.nth(0)).toContainText('Done');
  await expect(results.nth(1)).toContainText('Failed');
  await expect(results.nth(1)).toContainText('Partner');
  await expect(results.nth(2)).toContainText('Not run');
  expect(await liveOptions(person.subject)).toEqual([
    'Customer',
    'Channel partner',
    'Legacy',
    'Vendor',
  ]);
  await shot(page, testInfo, 'jira-admin-changes-05-partial');

  // --- A global context is called out before anyone applies it. ---
  const global = await proposeInChat(page, modelId, 'jira_admin_propose_option_changes', {
    field: 'Source',
    context: 'Default Configuration Scheme for Source',
    add: ['Vendor'],
  });
  await page.goto(`/jira-admin/changes/${global}`);
  await expect(main(page).getByTestId('change-reach')).toContainText(
    'it reaches every space that has no context of its own'
  );
  await shot(page, testInfo, 'jira-admin-changes-06-global');

  // --- The connection lost the scope the writes need: Apply is off, and says why. ---
  // The person reconnects with a narrower choice (the card's picker), so the
  // grant no longer carries manage:jira-configuration.
  await connectJiraAdministration(page, ['read:jira-user', 'read:jira-work']);
  await page.goto(`/jira-admin/changes/${global}`);
  await expect(main(page).getByText(/does not include manage:jira-configuration/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Apply this change to Jira' })).toBeDisabled();
  const refused = await page.request.post(`/api/jira-admin/changes/${global}/apply`);
  expect(refused.status()).toBe(403);
  await expect(main(page).getByTestId('change-state')).toHaveText('Waiting for review');
  await shot(page, testInfo, 'jira-admin-changes-07-refused');

  // --- Declining closes it. ---
  await page.getByRole('button', { name: 'Decline it' }).click();
  await page.getByRole('button', { name: 'Send the decline' }).click();
  await expect(main(page).getByTestId('change-state')).toHaveText('Cancelled', { timeout: 30_000 });
  await expect(page.getByRole('button', { name: 'Send the decline' })).toHaveCount(0);

  // --- Someone else's: an operator reviews it; anyone else cannot see it. ---
  // Another operator: proposing is an operator's (a person without the role asks in words).
  const someone = await createPerson(request, {
    displayName: 'Sam Someone',
    roles: ['renkei-user', 'renkei-operator'],
  });
  const ordinary = await createPerson(request, { displayName: 'Ola Ordinary' });
  const someoneContext = await browser.newContext({ reducedMotion: 'reduce' });
  const ordinaryContext = await browser.newContext({ reducedMotion: 'reduce' });
  try {
    await signIn(someoneContext, someone);
    const someonePage = await someoneContext.newPage();
    await connectJiraAdministration(someonePage);
    const theirs = await proposeInChat(someonePage, modelId, 'jira_admin_propose_option_changes', {
      field: 'Source',
      space: 'OPS',
      add: ['Vendor'],
    });
    // The operator reconnects with every box ticked again.
    await connectJiraAdministration(page);
    await page.goto(`/jira-admin/changes/${theirs}`);
    await expect(page.getByRole('heading', { name: 'Review a Jira admin change' })).toBeVisible();
    await expect(main(page).getByTestId('change-requester')).toContainText('by Sam Someone');
    // Sam works in a Jira site of his own (no shared email domain): this
    // operator's connection is on another, so approving is refused, with
    // the reason, and the request stays pending.
    await page.getByRole('button', { name: 'Approve and apply this change to Jira' }).click();
    // Filtered: Next's route announcer is a role="alert" too.
    await expect(page.getByRole('alert').filter({ hasText: /different Jira site/ })).toBeVisible();
    await page.reload();
    await expect(main(page).getByTestId('change-state')).toHaveText('Waiting for review');

    // A person who is not an operator gets not-found, on the page and at the
    // routes (the approval itself is an operator's: refused outright).
    await signIn(ordinaryContext, ordinary);
    const ordinaryPage = await ordinaryContext.newPage();
    // The page streams behind the layout's loading state, so its not-found
    // arrives as content rather than a 404 status — assert on that.
    await ordinaryPage.goto(`/jira-admin/changes/${theirs}`);
    await expect(
      ordinaryPage.getByRole('heading', { name: 'This page could not be found.' })
    ).toBeVisible();
    await expect(
      ordinaryPage.getByRole('heading', { name: 'Review a Jira admin change' })
    ).toHaveCount(0);
    const cannotApprove = await ordinaryPage.request.post(
      `/api/jira-admin/changes/${theirs}/apply`
    );
    expect(cannotApprove.status()).toBe(403);
    const cannotSee = await ordinaryPage.request.post(`/api/jira-admin/changes/${theirs}/cancel`);
    expect(cannotSee.status()).toBe(404);
    // Still waiting, for the operator.
    await page.reload();
    await expect(main(page).getByTestId('change-state')).toHaveText('Waiting for review');
    // Theirs is in their own site, untouched too.
    expect(await liveOptions(someone.subject)).toEqual(['Customer', 'Partner', 'Legacy']);
  } finally {
    await someoneContext.close();
    await ordinaryContext.close();
  }

  // Nothing any refusal touched reached Jira: only the stale one's first step ran.
  expect(await liveOptions(person.subject)).toEqual([
    'Customer',
    'Channel partner',
    'Legacy',
    'Vendor',
  ]);
});

test('an agent’s proposal can page its owner: Jira Administration has its own notification group', async ({
  page,
  person: _person,
}, testInfo) => {
  await page.goto(`/preferences`);
  const notifications = page.getByRole('region', { name: 'Notifications' });
  const summary = notifications.locator('summary').filter({ hasText: 'Jira Administration' });
  await expect(summary).toHaveCount(1);
  await summary.click();
  // A proposal files under "Creates something"; its switch is its own,
  // apart from everyday Jira's.
  await expect(
    notifications.getByRole('checkbox', { name: 'Jira Administration Creates something — App' })
  ).toBeVisible();
  await shot(page, testInfo, 'jira-admin-changes-08-notifications');

  await page.setViewportSize(MOBILE_VIEWPORT);
  await expect(
    notifications.getByRole('checkbox', { name: 'Jira Administration Creates something — App' })
  ).toBeVisible();
  await noHorizontalOverflow(page);
});
