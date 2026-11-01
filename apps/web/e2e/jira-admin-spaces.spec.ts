/**
 * Jira space templates and new spaces, end to end in a browser: an
 * organization's templates listed from the Jira Administration card, a
 * new space proposed from one reviewed with the schemes it will run on and
 * its access changes labelled, then applied — the space now exists in the
 * stand-in Jira of e2e/sandbox-stub.mjs (reached through
 * JIRA_ADMIN_API_BASE_URL).
 *
 * What each step says, what applying sends (the space on the stored
 * scheme ids, its roles filled without a member Jira already put in, its
 * components and versions) and what stops it (a key taken since, a role
 * Jira refuses) are lib/jira-admin/space-creation.test.ts; that a space
 * with components waits for a connection with manage:jira-project is
 * lib/jira-admin/apply.test.ts (the reason) and change-actions.model.test.ts
 * beside the review page (Apply off, saying why).
 *
 * The person connects Jira Administration through its real connect flow
 * (the in-memory app's fake OAuth, e2e/support/jira-admin.ts), and the
 * template and the proposal are their assistant's: chat turns on the
 * stand-in model calling jira_admin_save_space_template (which reads OPS's
 * schemes, roles and components from the stand-in Jira) and
 * jira_admin_propose_space.
 *
 * Each person works in a Jira site of their own, so the stub's spaces
 * start fresh for every test. Templates are the organization's, shared by
 * every test on the server: each test names its own with a tag and looks
 * only at that one.
 *
 * Pinned Chromium; "mobile" is a resized viewport, per AGENTS.md.
 */

import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { Page, TestInfo } from '@playwright/test';
import {
  callInChat,
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
test.use({ roles: ['renkei-user', 'renkei-operator'] });

/** A space as the stand-in Jira holds it, or null. */
async function stubSpace(subject: string, key: string): Promise<Record<string, unknown> | null> {
  const response = await fetch(
    `${JIRA_STUB}/${fakeJiraSite(subject).cloudId}/rest/api/3/project/${key}`
  );
  if (!response.ok) return null;
  const body: unknown = await response.json();
  return typeof body === 'object' && body !== null
    ? Object.fromEntries(Object.entries(body))
    : null;
}

async function shot(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  await page.screenshot({
    path: path.join(RESULTS, 'screens', testInfo.project.name, `${name}.png`),
    fullPage: true,
  });
}

async function noHorizontalOverflow(page: Page): Promise<void> {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth
  );
  expect(overflow).toBeLessThanOrEqual(0);
}

/** Right after a full load React can still hold a hidden copy of a streamed segment outside <main>. */
function main(page: Page) {
  return page.getByRole('main');
}

let modelId = '';

test.beforeEach(async ({ page, request, person: _person }, testInfo) => {
  await prepareJiraAdministration(request);
  const tag = `${testInfo.project.name}-${randomUUID().slice(0, 6)}`;
  template = `Ops standard ${tag}`;
  modelId = await addStubModel(page.request, `jira-spaces-${tag}`);
});

test.afterEach(async ({ page }) => {
  if (modelId) await removeModel(page.request, modelId);
  modelId = '';
});

/** This test's template's name: "Ops standard", tagged. */
let template = '';

/** OPS saved as the test's "Ops standard" template, as the assistant saves it. */
async function saveTemplate(page: Page): Promise<void> {
  const answer = await callInChat(page, modelId, 'jira_admin_save_space_template', {
    space: 'OPS',
    name: template,
    description: 'How operations spaces are set up',
  });
  expect(answer).toContain(template);
}

/** A new space from the template, led by Dana, with Dana as an administrator and a first version. */
async function proposeSpace(page: Page, key: string): Promise<string> {
  return proposeInChat(page, modelId, 'jira_admin_propose_space', {
    key,
    name: 'Finance',
    lead: 'dana@example.com',
    template,
    members: [{ role: 'Administrators', users: ['dana@example.com'] }],
    versions: [{ name: 'FY27', startDate: '2026-10-01', releaseDate: '2027-09-30' }],
  });
}

test('a template’s new space is reviewed scheme by scheme, then created with its roles', async ({
  page,
  person,
}, testInfo) => {
  const site = fakeJiraSite(person.subject).url;
  await connectJiraAdministration(page);
  await saveTemplate(page);
  const id = await proposeSpace(page, 'FIN');

  // --- The organization's templates, from the Jira Administration card. ---
  await page.goto(`/connectors`);
  const card = page.locator('[data-coach="card-jira-admin"]').filter({ visible: true });
  await card.getByTestId('jira-admin-templates-link').click();
  // A client-side navigation to a route that may compile on first visit.
  await expect(page).toHaveURL(new RegExp(`/jira-admin/templates$`), {
    timeout: 30_000,
  });
  const templateCard = main(page).getByTestId('space-template').filter({ hasText: template });
  await expect(templateCard).toHaveCount(1);
  await expect(templateCard).toContainText('Workflows: “OPS workflows”');
  await expect(templateCard).toContainText('Field configuration: the system default');
  await expect(templateCard).toContainText(
    'Roles: Administrators — ops-admins; Developers — jira-software-users'
  );
  await expect(templateCard.getByTestId('space-template-components')).toHaveText(
    'Components: Backend, Reports'
  );
  await shot(page, testInfo, 'jira-admin-spaces-01-templates');

  // --- The proposal, reviewed. ---
  await page.goto(`/jira-admin/changes/${id}`);
  await expect(page.getByRole('heading', { name: 'Review a Jira admin change' })).toBeVisible();
  await expect(main(page).getByTestId('change-reach')).toHaveText(
    `Where: A new space FIN on ${site}, running on the same schemes as ` +
      `template “${template}” rather than copies of them — a later change to one of those ` +
      'schemes changes every space on it.'
  );
  const operations = main(page).getByTestId('change-operations').locator(':scope > li');
  await expect(operations).toHaveCount(5);
  // The creation and role steps change who can see or do what, and say so;
  // components and versions do not.
  await expect(
    main(page).getByTestId('change-operations').getByText('Access', { exact: true })
  ).toHaveCount(3);
  expect(await stubSpace(person.subject, 'FIN')).toBeNull();
  await shot(page, testInfo, 'jira-admin-spaces-02-review');

  // --- Applied: every step ran, and the space is in Jira. ---
  await page.getByRole('button', { name: 'Apply these 5 changes to Jira' }).click();
  await expect(main(page).getByTestId('change-state')).toHaveText('Applied', { timeout: 30_000 });
  await expect(operations).toHaveCount(5);
  await expect(operations.nth(0)).toContainText('Done');
  await expect(operations.nth(0)).toContainText(`${site}/browse/FIN`);
  for (const index of [2, 3, 4]) {
    await expect(operations.nth(index)).toContainText('Done');
  }

  const created = await stubSpace(person.subject, 'FIN');
  expect(created?.created).toMatchObject({ key: 'FIN', name: 'Finance' });
  await shot(page, testInfo, 'jira-admin-spaces-03-applied');

  // Mobile: a resized Chromium viewport, not a device descriptor.
  await page.setViewportSize(MOBILE_VIEWPORT);
  await noHorizontalOverflow(page);
  await page.goto(`/jira-admin/templates`);
  await expect(main(page).getByTestId('space-template').filter({ hasText: template })).toHaveCount(
    1
  );
  await noHorizontalOverflow(page);
  await shot(page, testInfo, 'jira-admin-spaces-04-mobile');
});
