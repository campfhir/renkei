/**
 * Admin change requests as a queue an operator works through, end to end in
 * a browser, on the Jira side (the stand-in Jira in e2e/sandbox-stub.mjs
 * answers, so a change really applies). Salesforce's pages share the same
 * model and are driven in salesforce-admin.spec.ts.
 *
 * Three people of one organization (their email addresses share a domain,
 * so they work in one Jira site): an operator, Olive; an ordinary person,
 * Arlo, who may ask for a change in words but not approve one; and a
 * second operator, Pat, whose proposal Olive approves. Each connects Jira
 * Administration through the real connect flow (the in-memory app's fake
 * OAuth, e2e/support/jira-admin.ts), and every request is made the way
 * their assistant makes it: a chat turn on the stand-in model calling
 * jira_admin_request_change or jira_admin_propose_option_changes.
 *
 * Arlo's requests wait for an operator: he sees them, can withdraw his own,
 * and has no approve button; Olive sees everyone's, with who asked, and
 * declines one with a reason Arlo reads. Approving Pat's proposal queues
 * it: the click answers at once, the server applies it, and Olive can
 * leave the page and find it done on the list; both are told, and the
 * notification rows open the right page.
 *
 * Not reachable here: a change caught mid-apply ("Running now"). The
 * in-process job finishes against the stub in milliseconds, and nothing
 * holds a change half-applied. The audit trail's row is not read back: no
 * page lists it.
 *
 * Every test's people are of an organization of their own (a tagged email
 * domain), so their Jira site starts fresh; an operator's views count
 * everyone's, so assertions look at this test's own titles only.
 *
 * Pinned Chromium; "mobile" is a resized viewport, per AGENTS.md.
 */

import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { APIRequestContext, Browser, Page, TestInfo } from '@playwright/test';
import {
  connectJiraAdministration,
  fakeJiraSite,
  JIRA_STUB,
  prepareJiraAdministration,
  proposeInChat,
} from './support/jira-admin';
import { createPerson, signIn, type Person } from './support/person';
import { addStubModel, removeModel } from './support/stub-model';
import { test, expect } from './fixtures';

const RESULTS = path.join(import.meta.dirname, '..', 'test-results');
const MOBILE_VIEWPORT = { width: 390, height: 844 };
const FIELD_ID = 'customfield_10100';
const CONTEXT_ID = '10200';

async function shot(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  await page.screenshot({
    path: path.join(RESULTS, 'screens', testInfo.project.name, `${name}.png`),
    fullPage: true,
  });
}

const main = (page: Page) => page.getByRole('main');

async function noHorizontalOverflow(page: Page): Promise<void> {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth
  );
  expect(overflow).toBeLessThanOrEqual(0);
}

/** What the stand-in Jira holds for Source's OPS context in the organization's site. */
async function liveOptions(organization: string): Promise<string[]> {
  const response = await fetch(
    `${JIRA_STUB}/${fakeJiraSite(organization).cloudId}/rest/api/3/field/${FIELD_ID}/context/${CONTEXT_ID}/option`
  );
  const body: unknown = await response.json();
  const values: unknown[] =
    typeof body === 'object' && body !== null && 'values' in body && Array.isArray(body.values)
      ? body.values
      : [];
  return values.map((option) =>
    String(typeof option === 'object' && option !== null ? Reflect.get(option, 'value') : '')
  );
}

interface Member {
  person: Person;
  page: Page;
}

interface Organization {
  domain: string;
  tag: string;
  members: Member[];
  modelId: string;
}

/** A person of the organization, signed in in a browser of their own, connected to Jira Administration. */
async function join(
  browser: Browser,
  request: APIRequestContext,
  org: Pick<Organization, 'domain' | 'members'>,
  who: { name: string; operator: boolean }
): Promise<Member> {
  const person = await createPerson(request, {
    displayName: who.name,
    email: `${who.name.split(' ')[0]?.toLowerCase()}@${org.domain}`,
    roles: who.operator ? ['renkei-user', 'renkei-operator'] : ['renkei-user'],
  });
  const context = await browser.newContext();
  await signIn(context, person);
  const page = await context.newPage();
  await connectJiraAdministration(page);
  const member = { person, page };
  org.members.push(member);
  return member;
}

let org: Organization | null = null;

test.beforeEach(async ({ request, person: _person }, testInfo) => {
  test.setTimeout(180_000);
  await prepareJiraAdministration(request);
  const tag = `${testInfo.project.name}-${randomUUID().slice(0, 6)}`;
  org = { domain: `queue-${tag}.example`, tag, members: [], modelId: '' };
});

test.afterEach(async () => {
  if (!org) return;
  const operator = org.members.find((member) => member.person.roles.includes('renkei-operator'));
  if (operator && org.modelId) await removeModel(operator.page.request, org.modelId);
  for (const member of org.members) await member.page.context().close();
  org = null;
});

function current(): Organization {
  if (!org) throw new Error('no organization staged');
  return org;
}

test('an ordinary person asks and follows; an operator sees who asked and declines with a reason', async ({
  browser,
  request,
}, testInfo) => {
  const team = current();
  const olive = await join(browser, request, team, { name: 'Olive Operator', operator: true });
  const arlo = await join(browser, request, team, { name: 'Arlo Asker', operator: false });
  team.modelId = await addStubModel(olive.page.request, `queue-${team.tag}`);

  const vendor = `Queue ${team.tag}: please add a Vendor option`;
  const reseller = `Queue ${team.tag}: please add a Reseller option`;
  const asked = await proposeInChat(arlo.page, team.modelId, 'jira_admin_request_change', {
    title: vendor,
    description: 'The Source field in OPS needs a Vendor option for procurement tickets.',
    reason: 'Procurement tags vendor tickets',
  });
  const words = await proposeInChat(arlo.page, team.modelId, 'jira_admin_request_change', {
    title: reseller,
    description: 'The Source field in OPS needs a Reseller option for partner tickets.',
  });

  // --- The person who asked: their own, waiting for an operator, nothing to approve. ---
  const page = arlo.page;
  await page.goto('/jira-admin/changes');
  await expect(page.getByRole('heading', { name: 'Waiting for an operator' })).toBeVisible();
  const waiting = main(page).getByTestId('changes-waiting');
  await expect(waiting.getByRole('link', { name: new RegExp(vendor) })).toBeVisible();
  await expect(waiting.getByRole('link', { name: new RegExp(reseller) })).toBeVisible();
  await shot(page, testInfo, 'admin-change-queue-01-asker-list');

  await waiting.getByRole('link', { name: new RegExp(vendor) }).click();
  await expect(page.getByRole('heading', { name: 'Review a Jira admin change' })).toBeVisible({
    timeout: 30_000,
  });
  await expect(main(page).getByTestId('change-requester')).toContainText('by you');
  await expect(
    main(page).getByText(/An operator reviews and approves changes to Jira/)
  ).toBeVisible();
  await expect(page.getByRole('button', { name: /Approve/ })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Decline it' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Withdraw it' })).toBeVisible();
  await shot(page, testInfo, 'admin-change-queue-02-asker-review');

  // The route holds the line, whatever the page shows.
  const refused = await page.request.post(`/api/jira-admin/changes/${asked}/apply`);
  expect(refused.status()).toBe(403);
  expect((await refused.json()).error).toMatch(/operator/);
  await page.reload();
  await expect(main(page).getByTestId('change-state')).toHaveText('Waiting for review');

  // A request in words says what was asked, and offers nothing to approve.
  await page.goto(`/jira-admin/changes/${words}`);
  await expect(main(page).getByTestId('change-request-text')).toContainText(
    'needs a Reseller option for partner tickets'
  );

  // Mobile: the same pages at phone width.
  await page.setViewportSize(MOBILE_VIEWPORT);
  await noHorizontalOverflow(page);
  await shot(page, testInfo, 'admin-change-queue-03-asker-request-mobile');
  await page.setViewportSize({ width: 1280, height: 900 });

  // --- The operator: everyone's, with who asked; a request in words cannot be approved. ---
  const operator = olive.page;
  await operator.goto('/jira-admin/changes');
  await expect(operator.getByRole('heading', { name: 'Waiting for approval' })).toBeVisible();
  const row = main(operator)
    .getByTestId('changes-waiting')
    .getByRole('link', { name: new RegExp(reseller) });
  await expect(row).toContainText('Requested');
  await expect(row).toContainText('by Arlo Asker');
  await shot(operator, testInfo, 'admin-change-queue-04-operator-list');

  await row.click();
  await expect(main(operator).getByTestId('change-request-text')).toBeVisible({ timeout: 30_000 });
  await expect(operator.getByRole('button', { name: /Approve/ })).toHaveCount(0);
  const notApprovable = await operator.request.post(`/api/jira-admin/changes/${words}/apply`);
  expect(notApprovable.status()).toBe(409);
  expect((await notApprovable.json()).error).toMatch(/request in words/);

  // --- Declining asks for a reason, and the person who asked reads it. ---
  await operator.getByRole('button', { name: 'Decline it' }).click();
  await operator
    .getByLabel('Why (the requester reads this)')
    .fill('Use the existing Partner option');
  await operator.getByRole('button', { name: 'Send the decline' }).click();
  await expect(main(operator).getByTestId('change-state')).toHaveText('Cancelled', {
    timeout: 30_000,
  });

  await page.goto(`/jira-admin/changes/${words}`);
  await expect(main(page).getByTestId('change-resolution')).toContainText(
    'Use the existing Partner option'
  );
  await shot(page, testInfo, 'admin-change-queue-05-asker-declined');

  // The ordinary person withdraws their other request.
  await page.goto(`/jira-admin/changes/${asked}`);
  await page.getByRole('button', { name: 'Withdraw it' }).click();
  await expect(main(page).getByTestId('change-state')).toHaveText('Cancelled', {
    timeout: 30_000,
  });
});

test('approving queues the change, the server applies it, and the operator need not stay', async ({
  browser,
  request,
}, testInfo) => {
  const team = current();
  const olive = await join(browser, request, team, { name: 'Olive Operator', operator: true });
  const pat = await join(browser, request, team, { name: 'Pat Proposer', operator: true });
  team.modelId = await addStubModel(olive.page.request, `queue-${team.tag}`);
  const before = await liveOptions(team.domain);

  const id = await proposeInChat(pat.page, team.modelId, 'jira_admin_propose_option_changes', {
    field: 'Source',
    space: 'OPS',
    add: [`Vendor ${team.tag}`],
    reason: 'Procurement tags vendor tickets',
  });

  const page = olive.page;
  await page.goto(`/jira-admin/changes/${id}`);
  await expect(main(page).getByTestId('change-requester')).toContainText('by Pat Proposer');
  await shot(page, testInfo, 'admin-change-queue-06-operator-review');

  // The click answers at once with 202: nothing runs inside the request.
  const approve = page.waitForResponse(
    (response) =>
      response.url().includes(`/api/jira-admin/changes/${id}/apply`) &&
      response.request().method() === 'POST'
  );
  await page.getByRole('button', { name: 'Approve and apply this change to Jira' }).click();
  expect((await approve).status()).toBe(202);
  // Queued, so the operator may leave. Against the stub the apply can finish
  // before the page's refresh lands, and then the page already shows who
  // approved it instead of the queued notice.
  await expect(
    page.getByTestId('change-queued').or(main(page).getByTestId('change-approver'))
  ).toBeVisible();

  // Leave without waiting: the list follows it to the end by itself.
  await page.goto('/jira-admin/changes');
  const ours = main(page).locator(`a[href$="/jira-admin/changes/${id}"]`);
  await expect(ours.getByTestId('change-state')).toHaveText('Applied', { timeout: 60_000 });
  // It ran on the organization's site, and Jira really has the option.
  expect(await liveOptions(team.domain)).toEqual([...before, `Vendor ${team.tag}`]);

  // The page says who asked, who approved, and what ran.
  await ours.click();
  await expect(main(page).getByTestId('change-approver')).toContainText('by you');
  await expect(main(page).getByTestId('change-requester')).toContainText('by Pat Proposer');
  await expect(main(page).getByTestId('change-operations').getByText('Done')).toHaveCount(1);
  await shot(page, testInfo, 'admin-change-queue-07-applied');

  // Both were told how it ended; the row opens the review page.
  await pat.page.goto('/notifications');
  const note = main(pat.page).getByText(/Your Jira change was applied/);
  await expect(note).toBeVisible({ timeout: 30_000 });
  // Its own icon, not Jira's logo: it must not read as another Jira event.
  await expect(main(pat.page).getByTestId('change-notification-icon').first()).toBeVisible();
  await shot(pat.page, testInfo, 'admin-change-queue-08-asker-notified');
  await page.goto('/notifications');
  await expect(
    main(page)
      .getByText(/The Jira change was applied/)
      .first()
  ).toBeVisible({
    timeout: 30_000,
  });
  await pat.page.setViewportSize(MOBILE_VIEWPORT);
  await noHorizontalOverflow(pat.page);
});

test('the notification row for a waiting proposal opens the right page', async ({
  browser,
  request,
}, testInfo) => {
  const team = current();
  const olive = await join(browser, request, team, { name: 'Olive Operator', operator: true });
  const pat = await join(browser, request, team, { name: 'Pat Proposer', operator: true });
  team.modelId = await addStubModel(olive.page.request, `queue-${team.tag}`);
  const id = await proposeInChat(pat.page, team.modelId, 'jira_admin_propose_option_changes', {
    field: 'Source',
    space: 'OPS',
    add: [`Vendor ${team.tag}`],
  });

  // Every operator but the one who proposed is told it waits; Olive's row is asserted.
  const page = olive.page;
  await page.goto('/notifications');
  const link = main(page).getByRole('link', {
    name: new RegExp(`A Jira change is waiting for your approval: .*Vendor ${team.tag}`),
  });
  await expect(link).toBeVisible({ timeout: 30_000 });
  await expect(main(page).getByTestId('change-notification-icon').first()).toBeVisible();
  await shot(page, testInfo, 'admin-change-queue-12-notification');
  // The headline is the row's link, stretched over the whole card.
  await link.click();
  await expect(page).toHaveURL(new RegExp(`/jira-admin/changes/${id}$`), { timeout: 30_000 });
  await expect(main(page).getByTestId('change-title')).toContainText(`Vendor ${team.tag}`);
});
