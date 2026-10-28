/**
 * Jira space templates and new spaces, end to end in a browser: an
 * organization's templates listed from the Jira Administration card, a
 * new space proposed from one reviewed with every scheme it will run on
 * and every access change labelled, then applied — creating the space,
 * filling its roles and adding its components and versions in the
 * stand-in Jira of e2e/sandbox-stub.mjs (reached through
 * JIRA_ADMIN_API_BASE_URL), without adding a member Jira already put in.
 * A key taken between proposal and apply stops everything before anything
 * is created, and a connection without the components permission is told
 * to reconnect rather than offered an Apply that would fail half-way.
 *
 * The person connects Jira Administration through its real connect flow
 * (the in-memory app's fake OAuth, e2e/support/jira-admin.ts), and the
 * template and the proposal are their assistant's: chat turns on the
 * stand-in model calling jira_admin_save_space_template (which reads OPS's
 * schemes, roles and components from the stand-in Jira) and
 * jira_admin_propose_space. The audit trail's row is not read back: no
 * page lists it.
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
} from '../support/jira-admin';
import { addStubModel, removeModel } from '../support/stub-model';
import { test, expect } from './fixtures';

const RESULTS = path.join(import.meta.dirname, '..', '..', 'test-results', 'memory');
const MOBILE_VIEWPORT = { width: 390, height: 844 };
/** Every box but "Space components, versions and screens" (manage:jira-project). */
const WITHOUT_COMPONENTS = ['read:jira-user', 'read:jira-work', 'manage:jira-configuration'];

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
  await expect(operations.nth(0)).toContainText(
    'Create the software space FIN — “Finance” — led by Dana Admin, on the schemes of ' +
      `template “${template}”`
  );
  await expect(operations.nth(0).getByTestId('operation-details')).toContainText(
    'Workflows: “OPS workflows” — shared with 2 spaces'
  );
  await expect(operations.nth(0).getByTestId('operation-details')).toContainText(
    'Permissions: “Internal permissions”'
  );
  await expect(operations.nth(1)).toContainText(
    'Add group “ops-admins”, Dana Admin to the Administrators role'
  );
  await expect(operations.nth(3)).toContainText('Add 2 components: Backend, Reports');
  await expect(operations.nth(3).getByTestId('operation-details')).toContainText(
    'Reports (its issues go to the space lead)'
  );
  await expect(operations.nth(4)).toContainText('Add 1 version: FY27');
  // The creation and role steps change who can see or do what, and say so;
  // components and versions do not.
  await expect(
    main(page).getByTestId('change-operations').getByText('Access', { exact: true })
  ).toHaveCount(3);
  expect(await stubSpace(person.subject, 'FIN')).toBeNull();
  await shot(page, testInfo, 'jira-admin-spaces-02-review');

  // --- Applied: the space exists on the stored schemes, its roles filled once. ---
  await page.getByRole('button', { name: 'Apply these 5 changes to Jira' }).click();
  await expect(main(page).getByTestId('change-state')).toHaveText('Applied', { timeout: 30_000 });
  await expect(operations).toHaveCount(5);
  await expect(operations.nth(0)).toContainText('Done');
  await expect(operations.nth(0)).toContainText(`${site}/browse/FIN`);
  // Jira's default put ops-admins in already; only Dana was added.
  await expect(operations.nth(1)).toContainText('1 already in the role.');
  await expect(operations.nth(2)).toContainText('Done');
  await expect(operations.nth(3)).toContainText('Done');
  await expect(operations.nth(4)).toContainText('Done');

  const created = await stubSpace(person.subject, 'FIN');
  expect(created?.created).toMatchObject({
    key: 'FIN',
    name: 'Finance',
    leadAccountId: 'acct-dana',
    projectTypeKey: 'software',
    assigneeType: 'UNASSIGNED',
    issueTypeScheme: 11,
    issueTypeScreenScheme: 12,
    workflowScheme: 13,
    permissionScheme: 15,
    notificationScheme: 16,
  });
  expect(created?.roles).toEqual({
    10002: [
      {
        type: 'atlassian-group-role-actor',
        actorGroup: { name: 'ops-admins', displayName: 'ops-admins', groupId: 'g-admins' },
      },
      { type: 'atlassian-user-role-actor', actorUser: { accountId: 'acct-dana' } },
    ],
    10001: [
      { type: 'atlassian-group-role-actor', actorGroup: { groupId: 'g-users', name: 'g-users' } },
    ],
  });
  expect(created?.components).toEqual([
    expect.objectContaining({
      project: 'FIN',
      name: 'Backend',
      description: 'Services and jobs',
      assigneeType: 'PROJECT_DEFAULT',
    }),
    expect.objectContaining({ project: 'FIN', name: 'Reports', assigneeType: 'PROJECT_LEAD' }),
  ]);
  // Versions go to the id Jira gave the new space.
  expect(created?.versions).toEqual([
    expect.objectContaining({
      projectId: Number(created?.id),
      name: 'FY27',
      startDate: '2026-10-01',
      releaseDate: '2027-09-30',
    }),
  ]);
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

test('a key taken since the proposal stops it before anything is created', async ({
  page,
  person,
}, testInfo) => {
  await connectJiraAdministration(page);
  await saveTemplate(page);
  const id = await proposeSpace(page, 'TAKEN');
  // Someone made TAKEN by hand in Jira after the proposal.
  await fetch(`${JIRA_STUB}/${fakeJiraSite(person.subject).cloudId}/rest/api/3/project`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ key: 'TAKEN', name: 'Made by hand' }),
  });

  await page.goto(`/jira-admin/changes/${id}`);
  await page.getByRole('button', { name: 'Apply these 5 changes to Jira' }).click();
  await expect(main(page).getByTestId('change-state')).toHaveText('Failed', { timeout: 30_000 });
  const operations = main(page).getByTestId('change-operations').locator(':scope > li');
  await expect(operations.nth(0)).toContainText(
    'TAKEN cannot be used now: A project with that project key already exists.'
  );
  for (const index of [1, 2, 3, 4]) {
    await expect(operations.nth(index)).toContainText('Not run');
  }
  // The hand-made space is untouched: nothing was created or added.
  const space = await stubSpace(person.subject, 'TAKEN');
  expect(space?.name).toBe('Made by hand');
  await shot(page, testInfo, 'jira-admin-spaces-05-key-taken');
});

test('a new space with components waits for a connection that can add them', async ({
  page,
  person,
}, testInfo) => {
  // Connected without the components permission (the card's picker left it out).
  await connectJiraAdministration(page, WITHOUT_COMPONENTS);
  await saveTemplate(page);
  const id = await proposeSpace(page, 'FIN');

  await page.goto(`/jira-admin/changes/${id}`);
  await expect(
    main(page).getByText(
      'Your Jira Administration connection does not include manage:jira-project. Reconnect ' +
        'it with Space components, versions and screens ticked (if it is not offered, an ' +
        'organization admin allows it under Connector setup first).'
    )
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Apply these 5 changes to Jira' })).toBeDisabled();
  expect(await stubSpace(person.subject, 'FIN')).toBeNull();
  await shot(page, testInfo, 'jira-admin-spaces-06-needs-reconnect');
});
