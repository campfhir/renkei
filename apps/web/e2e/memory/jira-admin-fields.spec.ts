/**
 * A field for a space, end to end in a browser: a proposal to create a
 * "Vendor" select list for OPS, reviewed with every step in plain words —
 * and, in the warning colour, the screen another space (HR) shows too —
 * then applied against the stand-in Jira of e2e/sandbox-stub.mjs (reached
 * through JIRA_ADMIN_API_BASE_URL): the field is created, OPS gets a
 * context of its own with the options, and the field lands on each screen
 * tab. A field of the same name made between proposal and apply stops it
 * before a second one is created.
 *
 * The person connects Jira Administration through its real connect flow
 * (the in-memory app's fake OAuth, e2e/support/jira-admin.ts), and the
 * proposal is made the way their assistant makes it: a chat turn on the
 * stand-in model calling jira_admin_propose_space_field, which reads the
 * space, the field and the screens from the stand-in Jira.
 *
 * Each person works in a Jira site of their own, so the stub's fields and
 * screens start fresh for every test.
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
  jiraStub,
  prepareJiraAdministration,
  proposeInChat,
} from '../support/jira-admin';
import { addStubModel, removeModel } from '../support/stub-model';
import { test, expect } from './fixtures';

const RESULTS = path.join(import.meta.dirname, '..', '..', 'test-results', 'memory');
const MOBILE_VIEWPORT = { width: 390, height: 844 };
const TITLE = 'New field “Vendor” for OPS';

test.use({ roles: ['renkei-user', 'renkei-operator'] });

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
  await connectJiraAdministration(page);
  modelId = await addStubModel(
    page.request,
    `jira-fields-${testInfo.project.name}-${randomUUID().slice(0, 6)}`
  );
});

test.afterEach(async ({ page }) => {
  if (modelId) await removeModel(page.request, modelId);
  modelId = '';
});

/** What the assistant proposes: the Vendor select list for OPS, on HR's shared screen too. */
async function proposeVendor(page: Page): Promise<string> {
  return proposeInChat(page, modelId, 'jira_admin_propose_space_field', {
    space: 'OPS',
    name: 'Vendor',
    type: 'select',
    description: 'Who supplies it',
    options: ['Acme', 'Globex'],
    sharedScreens: true,
    reason: 'Procurement asked',
  });
}

test('a new field is reviewed with the screen another space shows, then created, scoped and placed', async ({
  page,
  person,
}, testInfo) => {
  const id = await proposeVendor(page);

  // --- Reviewed: each step, and the screen HR shows too, in the warning colour. ---
  await page.goto(`/jira-admin/changes/${id}`);
  await expect(page.getByRole('heading', { name: 'Review a Jira admin change' })).toBeVisible();
  await expect(main(page).getByTestId('change-title')).toHaveText(TITLE);
  const reach = main(page).getByTestId('change-reach');
  await expect(reach).toContainText(
    'Some of the screens it goes on are shown by other spaces too (HR), and the field ' +
      'appears in those spaces as well.'
  );
  await expect(reach).toHaveClass(/bg-amber-50/);
  const operations = main(page).getByTestId('change-operations').locator(':scope > li');
  await expect(operations).toHaveCount(4);
  await expect(operations.nth(0)).toContainText(
    'Create the custom field “Vendor”, a select list (single choice)'
  );
  await expect(operations.nth(1)).toContainText(
    'Give “Vendor” a context of its own for OPS, offering “Acme”, “Globex”'
  );
  await expect(operations.nth(3)).toContainText(
    'Put “Vendor” on the screen “Shared bug screen”, tab “Details”'
  );
  await expect(operations.nth(3).getByTestId('operation-details')).toContainText(
    'Also shown by HR — the field appears there too'
  );
  expect(await jiraStub(person.subject, '/rest/api/3/field/search?query=Vendor')).toEqual([]);
  await shot(page, testInfo, 'jira-admin-fields-01-review');

  // --- Applied: the field, OPS's own context with its options, and each screen tab. ---
  await page.getByRole('button', { name: 'Apply these 4 changes to Jira' }).click();
  await expect(main(page).getByTestId('change-state')).toHaveText('Applied', { timeout: 30_000 });
  await expect(operations.nth(0)).toContainText(/Created as customfield_\d+\./);
  for (const index of [1, 2, 3]) {
    await expect(operations.nth(index)).toContainText('Done');
  }

  const fields = await jiraStub(person.subject, '/rest/api/3/field/search?query=Vendor');
  expect(fields).toHaveLength(1);
  const fieldId = String(fields[0]?.id);
  expect(fields[0]).toMatchObject({
    name: 'Vendor',
    description: 'Who supplies it',
    schema: { custom: 'com.atlassian.jira.plugin.system.customfieldtypes:select' },
    searcherKey: 'com.atlassian.jira.plugin.system.customfieldtypes:multiselectsearcher',
  });
  const mappings = await jiraStub(
    person.subject,
    `/rest/api/3/field/${fieldId}/context/projectmapping`
  );
  const own = mappings.find((mapping) => mapping.projectId === '10000');
  expect(own).toBeDefined();
  const options = await jiraStub(
    person.subject,
    `/rest/api/3/field/${fieldId}/context/${String(own?.contextId)}/option`
  );
  expect(options.map((option) => option.value)).toEqual(['Acme', 'Globex']);
  expect(await jiraStub(person.subject, '/rest/api/3/screens/41/tabs/410/fields')).toEqual([
    { id: fieldId, name: 'Vendor' },
  ]);
  expect(await jiraStub(person.subject, '/rest/api/3/screens/42/tabs/420/fields')).toEqual([
    { id: fieldId, name: 'Vendor' },
  ]);
  await shot(page, testInfo, 'jira-admin-fields-02-applied');

  // Mobile: a resized Chromium viewport, not a device descriptor.
  await page.setViewportSize(MOBILE_VIEWPORT);
  await noHorizontalOverflow(page);
  await shot(page, testInfo, 'jira-admin-fields-03-mobile');
});

test('a field of the same name made since stops it before a second is created', async ({
  page,
  person,
}, testInfo) => {
  const id = await proposeVendor(page);
  // Someone made a Vendor field by hand in Jira after the proposal.
  await fetch(`${JIRA_STUB}/${fakeJiraSite(person.subject).cloudId}/rest/api/3/field`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: 'Vendor',
      type: 'com.atlassian.jira.plugin.system.customfieldtypes:textfield',
    }),
  });

  await page.goto(`/jira-admin/changes/${id}`);
  await page.getByRole('button', { name: 'Apply these 4 changes to Jira' }).click();
  await expect(main(page).getByTestId('change-state')).toHaveText('Failed', { timeout: 30_000 });
  const operations = main(page).getByTestId('change-operations').locator(':scope > li');
  await expect(operations.nth(0)).toContainText(
    /A custom field named “Vendor” exists now \(customfield_\d+\), so another was not created\./
  );
  for (const index of [1, 2, 3]) {
    await expect(operations.nth(index)).toContainText('Not run');
  }
  // Still the one made by hand, and on no screen.
  expect(await jiraStub(person.subject, '/rest/api/3/field/search?query=Vendor')).toHaveLength(1);
  expect(await jiraStub(person.subject, '/rest/api/3/screens/41/tabs/410/fields')).toEqual([]);
  await shot(page, testInfo, 'jira-admin-fields-04-name-taken');
});
