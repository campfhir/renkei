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
 * The refusals moved out of the browser, each where it is decided:
 * - a proposal Jira moved underneath (an option renamed by hand since)
 *   stops at that operation and runs nothing after it —
 *   lib/jira-admin/field-options.test.ts;
 * - a global context called out before anyone applies it —
 *   lib/jira-admin/field-options.test.ts, lib/mcp-tools/jira-admin/changes.test.ts;
 * - a connection without the scope the writes need, Apply off and saying
 *   why — lib/jira-admin/apply.test.ts (the reason),
 *   app/api/jira-admin/changes/[changeId]/apply/route.test.ts (the 403),
 *   change-actions.model.test.ts beside the review page (the button);
 * - declining with a note — the cancel route test and the model;
 * - someone else's proposal, from another Jira site — resolveApplyAccess in
 *   lib/jira-admin/apply-job.test.ts and the apply route's 409; and a
 *   person who is not an operator gets not-found — mayView in
 *   lib/jira-admin/change-requests.test.ts, the apply route's 403 and the
 *   cancel route's 404;
 * - Jira Administration's own notification group, where a proposal
 *   "creates something" — packages/tool-outcomes/src/act-outcomes.test.ts.
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

test('a proposal waits for review, and applying it changes Jira exactly as shown @smoke', async ({
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
