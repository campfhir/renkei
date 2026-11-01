/**
 * Admin change requests as a queue an operator works through, in a
 * browser, on the Jira side: what only a page shows.
 *
 * - The notification row for a proposal waiting for approval opens its
 *   review page.
 * - The menu's Changes row counts what waits and opens the Changes page,
 *   whose row (connector, who asked, state) opens the connector's own
 *   review page; at phone width the row's pills wrap under its title. A
 *   person who is not an operator has no Changes row in the menu.
 *
 * The rules moved out of the browser, each where it is decided:
 * - a person who is not an operator cannot approve (403) and a request in
 *   words cannot be approved (409): app/api/jira-admin/changes/[changeId]/apply/route.test.ts;
 * - declining with a reason the requester reads, and withdrawing one's
 *   own: …/cancel/route.test.ts;
 * - approving queues the change (202) and the server applies it on the
 *   approving operator's connection, telling both people: the apply route
 *   test and lib/jira-admin/apply-job.test.ts;
 * - which buttons each person sees on the review page:
 *   app/(app)/jira-admin/changes/[changeId]/change-actions.model.test.ts;
 * - who sees whose requests on the Changes page, the connector filter and
 *   the menu's count: lib/admin-changes/sources.test.ts; that every
 *   operator but the proposer is told one waits: lib/admin-changes/stores.test.ts.
 *
 * Two people of one organization (their email addresses share a domain,
 * so they work in one Jira site), each connected to Jira Administration
 * through the real connect flow (the in-memory app's fake OAuth,
 * e2e/support/jira-admin.ts); every request is made the way their
 * assistant makes it: a chat turn on the stand-in model calling
 * jira_admin_request_change or jira_admin_propose_option_changes.
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
  prepareJiraAdministration,
  proposeInChat,
} from './support/jira-admin';
import { createPerson, signIn, type Person } from './support/person';
import { addStubModel, removeModel } from './support/stub-model';
import { test, expect } from './fixtures';
import { steady } from './support/settle';

const RESULTS = path.join(import.meta.dirname, '..', 'test-results');
const MOBILE_VIEWPORT = { width: 390, height: 844 };

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
  const context = await browser.newContext({ reducedMotion: 'reduce' });
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

test('an operator finds the waiting changes from the menu; a person who asked has no menu row', async ({
  browser,
  request,
}, testInfo) => {
  const team = current();
  const olive = await join(browser, request, team, { name: 'Olive Operator', operator: true });
  const arlo = await join(browser, request, team, { name: 'Arlo Asker', operator: false });
  team.modelId = await addStubModel(olive.page.request, `queue-${team.tag}`);
  const title = `Queue ${team.tag}: please add a Partner option`;
  const id = await proposeInChat(arlo.page, team.modelId, 'jira_admin_request_change', {
    title,
    description: 'The Source field in OPS needs a Partner option.',
  });

  // --- The operator: the menu's Changes row counts what waits, and opens the list. ---
  const page = olive.page;
  await page.goto('/');
  const menu = page.getByRole('navigation', { name: 'Application' }).filter({ visible: true });
  const changes = menu.getByRole('link', { name: /^Changes/ });
  // Every test's waiting changes count, so only that some wait is asserted.
  await expect(changes.getByTestId('nav-badge')).toHaveText(/^[1-9]\d*\+?$/);
  await changes.click();
  await expect(page).toHaveURL(/\/changes$/, { timeout: 30_000 });
  await expect(page.getByRole('heading', { name: 'Changes', level: 1 })).toBeVisible();
  await expect(changes).toHaveAttribute('aria-current', 'page');

  const row = main(page)
    .getByTestId('changes-waiting')
    .locator(`a[href$="/jira-admin/changes/${id}"]`);
  await expect(row).toContainText(title);
  await expect(row.getByTestId('change-source')).toHaveText('Jira');
  await expect(row).toContainText('requested');
  await expect(row).toContainText('by Arlo Asker');
  await expect(row.getByTestId('change-state')).toHaveText('Waiting for review');
  await shot(page, testInfo, 'admin-change-queue-13-changes-inbox');

  // Phone width: the list fits, and the status pills wrap under the title
  // rather than squeezing it into a narrow column beside them.
  await page.setViewportSize(MOBILE_VIEWPORT);
  await expect(row).toBeVisible();
  await noHorizontalOverflow(page);
  // Measured once the row has reflowed to the new width and holds still.
  const { rowBox, titleColumn, pill } = await steady(page, async () => ({
    rowBox: await row.boundingBox(),
    titleColumn: await row.getByTestId('change-row-title').locator('xpath=../..').boundingBox(),
    pill: await row.getByTestId('change-state').boundingBox(),
  }));
  expect(rowBox && titleColumn && pill).toBeTruthy();
  if (!rowBox || !titleColumn || !pill) return;
  expect(titleColumn.width).toBeGreaterThan(rowBox.width * 0.75);
  expect(pill.y).toBeGreaterThanOrEqual(titleColumn.y + titleColumn.height);
  await shot(page, testInfo, 'admin-change-queue-14-changes-inbox-mobile');
  await page.setViewportSize({ width: 1280, height: 900 });

  // The row opens the connector's own review page.
  await row.click();
  await expect(page).toHaveURL(new RegExp(`/jira-admin/changes/${id}$`), { timeout: 30_000 });
  await expect(main(page).getByTestId('change-title')).toContainText(title);

  // --- The person who asked: no Changes row in the menu. ---
  const asker = arlo.page;
  await asker.goto('/');
  await expect(
    asker
      .getByRole('navigation', { name: 'Application' })
      .filter({ visible: true })
      .getByRole('link', { name: /^Changes/ })
  ).toHaveCount(0);
});
