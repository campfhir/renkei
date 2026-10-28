/**
 * The three newer kinds of Jira admin change request, end to end in a
 * browser, each reviewed with every step in plain words and then applied
 * against the stand-in Jira of e2e/sandbox-stub.mjs (reached through
 * JIRA_ADMIN_API_BASE_URL):
 *
 * - a work type for OPS (an "Incident" with the bug icon, on Bug's screens
 *   and workflow, in a scheme HR shares — named in the warning colour): the
 *   type is created, given its icon, added to the scheme and mapped;
 * - changes to a screen (a field on, one off, a tab renamed);
 * - a request type for HELP, which applies on the JSM grant rather than
 *   the Jira Administration one — and is refused on its review page until
 *   that grant carries "Set up request types".
 *
 * The person connects Jira Administration (and Jira Service Management)
 * through the real connect flows — the in-memory app's fake OAuth,
 * e2e/support/jira-admin.ts — and each proposal is their assistant's: a
 * chat turn on the stand-in model calling its jira_admin_propose_ tool,
 * which reads what it changes from the stand-in Jira. The audit trail's
 * row is not read back: no page lists it.
 *
 * Each person works in a Jira site of their own: the stub keeps each
 * site's work types, screens and request types apart.
 *
 * Pinned Chromium; "mobile" is a resized viewport, per AGENTS.md.
 */

import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { Page, TestInfo } from '@playwright/test';
import {
  connectJiraAdministration,
  connectJiraServiceManagement,
  fakeJiraSite,
  JIRA_STUB,
  JSM_REQUEST_TYPE_SCOPES,
  prepareJiraAdministration,
  prepareJiraServiceManagement,
  proposeInChat,
} from '../support/jira-admin';
import { addStubModel, removeModel } from '../support/stub-model';
import { test, expect } from './fixtures';

const RESULTS = path.join(import.meta.dirname, '..', '..', 'test-results', 'memory');
const MOBILE_VIEWPORT = { width: 390, height: 844 };
/** JSM connected for reading requests only, without "Set up request types". */
const JSM_READ_SCOPES = ['read:request:jira-service-management'];

test.use({ roles: ['renkei-user', 'renkei-operator'] });

/** GET from the stand-in Jira for the person's site, as JSON. */
async function stub(subject: string, pathAndQuery: string, init?: RequestInit): Promise<unknown> {
  const response = await fetch(
    `${JIRA_STUB}/${fakeJiraSite(subject).cloudId}${pathAndQuery}`,
    init
  );
  return response.json();
}

function values(body: unknown): Record<string, unknown>[] {
  const list: unknown[] = Array.isArray(body)
    ? body
    : typeof body === 'object' && body !== null && 'values' in body && Array.isArray(body.values)
      ? body.values
      : [];
  return list.map((item) =>
    typeof item === 'object' && item !== null ? Object.fromEntries(Object.entries(item)) : {}
  );
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
  await connectJiraAdministration(page);
  modelId = await addStubModel(
    page.request,
    `jira-work-types-${testInfo.project.name}-${randomUUID().slice(0, 6)}`
  );
});

test.afterEach(async ({ page }) => {
  if (modelId) await removeModel(page.request, modelId);
  modelId = '';
});

test('a work type is reviewed with the scheme another space shares, then created, iconed and mapped', async ({
  page,
  person,
}, testInfo) => {
  const id = await proposeInChat(page, modelId, 'jira_admin_propose_work_type', {
    space: 'OPS',
    name: 'Incident',
    description: 'Something is down',
    icon: 'bug',
    like: 'Bug',
    sharedScheme: true,
    reason: 'The on-call rota asked',
  });

  // --- Reviewed: each step, and the scheme HR shares, in the warning colour. ---
  await page.goto(`/jira-admin/changes/${id}`);
  await expect(page.getByRole('heading', { name: 'Review a Jira admin change' })).toBeVisible();
  await expect(main(page).getByTestId('change-title')).toHaveText(
    'New work type “Incident” for OPS'
  );
  const reach = main(page).getByTestId('change-reach');
  await expect(reach).toContainText(
    'OPS’s work type scheme is shared with HR, and the work type appears in those spaces as well.'
  );
  await expect(reach).toHaveClass(/bg-amber-50/);
  const operations = main(page).getByTestId('change-operations').locator(':scope > li');
  await expect(operations).toHaveCount(5);
  await expect(operations.nth(0)).toContainText('Create the work type “Incident”');
  await expect(operations.nth(1)).toContainText('Give “Incident” the “bug” icon');
  await expect(operations.nth(2)).toContainText(
    'Add “Incident” to OPS’s work type scheme “OPS work types”'
  );
  await expect(operations.nth(2).getByTestId('operation-details')).toContainText(
    'Also used by HR — the work type appears there too'
  );
  await expect(operations.nth(3)).toContainText(
    'Show “Incident” on the screens “Bug” uses in OPS (screen scheme “Bug screen scheme”)'
  );
  await expect(operations.nth(4)).toContainText(
    'Run “Incident” on the workflow “Bug workflow” in OPS'
  );
  expect(
    values(await stub(person.subject, '/rest/api/3/issuetype')).map((type) => type.name)
  ).toEqual(['Task', 'Bug']);
  await shot(page, testInfo, 'jira-admin-work-types-01-review');

  // --- Applied: the type with its icon, in the scheme, on Bug's screens and workflow. ---
  await page.getByRole('button', { name: 'Apply these 5 changes to Jira' }).click();
  await expect(main(page).getByTestId('change-state')).toHaveText('Applied', { timeout: 30_000 });
  await expect(operations.nth(0)).toContainText(/Created as \d+\./);
  for (const index of [1, 2, 3, 4]) {
    await expect(operations.nth(index)).toContainText('Done');
  }

  const types = values(await stub(person.subject, '/rest/api/3/issuetype'));
  const incident = types.find((type) => type.name === 'Incident');
  expect(incident).toMatchObject({
    description: 'Something is down',
    avatarId: 10303,
    subtask: false,
  });
  const typeId = String(incident?.id);
  expect(
    values(
      await stub(person.subject, '/rest/api/3/issuetypescheme/mapping?issueTypeSchemeId=11')
    ).map((item) => item.issueTypeId)
  ).toEqual(['10001', '10002', typeId]);
  expect(
    values(
      await stub(
        person.subject,
        '/rest/api/3/issuetypescreenscheme/mapping?issueTypeScreenSchemeId=12'
      )
    )
  ).toContainEqual(expect.objectContaining({ issueTypeId: typeId, screenSchemeId: '31' }));
  const schemes = await stub(person.subject, '/rest/api/3/workflowscheme/read', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ workflowSchemeIds: ['13'] }),
  });
  expect(values(schemes)[0]?.workflowsForIssueTypes).toEqual([
    { workflow: { id: 'wf-bug', name: 'Bug workflow' }, issueTypeIds: ['10002', typeId] },
  ]);
  await shot(page, testInfo, 'jira-admin-work-types-02-applied');

  // Mobile: a resized Chromium viewport, not a device descriptor.
  await page.setViewportSize(MOBILE_VIEWPORT);
  await noHorizontalOverflow(page);
  await shot(page, testInfo, 'jira-admin-work-types-03-mobile');
});

test('changes to a screen are reviewed, then land on its tab in order', async ({
  page,
  person,
}, testInfo) => {
  // Source is on the create screen already (put there in Jira by hand).
  await stub(person.subject, '/rest/api/3/screens/41/tabs/410/fields', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ fieldId: 'customfield_10100' }),
  });
  const id = await proposeInChat(page, modelId, 'jira_admin_propose_screen_changes', {
    screen: 'OPS: Create',
    add: [{ field: 'Priority' }],
    remove: ['Source'],
    renameTabs: [{ from: 'Field Tab', to: 'Main' }],
    reason: 'The on-call rota asked',
  });

  await page.goto(`/jira-admin/changes/${id}`);
  await expect(main(page).getByTestId('change-title')).toHaveText(
    '3 changes to the screen “OPS: Create”'
  );
  const reach = main(page).getByTestId('change-reach');
  await expect(reach).toContainText('Only OPS shows it.');
  await expect(reach).not.toHaveClass(/bg-amber-50/);
  const operations = main(page).getByTestId('change-operations').locator(':scope > li');
  await expect(operations).toHaveCount(3);
  await expect(operations.nth(0)).toContainText('Put “Priority” on “OPS: Create”, tab “Field Tab”');
  await expect(operations.nth(1)).toContainText('Take “Source” off “OPS: Create”, tab “Field Tab”');
  await expect(operations.nth(1).getByTestId('operation-details')).toContainText(
    'The field and its values on every issue stay; it is no longer shown here.'
  );
  await expect(operations.nth(2)).toContainText(
    'Rename the tab “Field Tab” of “OPS: Create” to “Main”'
  );
  await shot(page, testInfo, 'jira-admin-work-types-04-screen-review');

  await page.getByRole('button', { name: 'Apply these 3 changes to Jira' }).click();
  await expect(main(page).getByTestId('change-state')).toHaveText('Applied', { timeout: 30_000 });
  // Priority went on, Source came off, and the tab has its new name.
  expect(values(await stub(person.subject, '/rest/api/3/screens/41/tabs/410/fields'))).toEqual([
    { id: 'priority', name: 'Priority' },
  ]);
  expect(values(await stub(person.subject, '/rest/api/3/screens/41/tabs'))).toEqual([
    { id: 410, name: 'Main' },
  ]);
  await shot(page, testInfo, 'jira-admin-work-types-05-screen-applied');
});

test('a request type waits for the JSM box, then applies on the JSM grant', async ({
  page,
  request,
  person,
}, testInfo) => {
  await prepareJiraServiceManagement(request);
  // Connected to JSM with the box on to propose (the tool reads the
  // service desk), then reconnected without it.
  await connectJiraServiceManagement(page, [...JSM_READ_SCOPES, ...JSM_REQUEST_TYPE_SCOPES]);
  const id = await proposeInChat(page, modelId, 'jira_admin_propose_request_type', {
    space: 'HELP',
    name: 'Report an outage',
    workType: 'Incident',
    description: 'Something is down for everyone',
    reason: 'The on-call rota asked',
  });
  await connectJiraServiceManagement(page, JSM_READ_SCOPES);

  await page.goto(`/jira-admin/changes/${id}`);
  await expect(main(page).getByTestId('change-title')).toHaveText(
    'New request type “Report an outage” for HELP'
  );
  await expect(main(page).getByTestId('change-reach')).toContainText(
    'Applying runs on your Jira Service Management connection.'
  );
  const operations = main(page).getByTestId('change-operations').locator(':scope > li');
  await expect(operations).toHaveCount(1);
  await expect(operations.nth(0)).toContainText(
    'Add the request type “Report an outage” to HELP, backed by the work type “Incident”'
  );
  await expect(operations.nth(0).getByTestId('operation-details')).toContainText(
    'stays hidden on the portal until an admin puts it in a portal group'
  );
  // Apply is off, and the page says which connection and which box.
  const apply = page.getByRole('button', { name: 'Apply this change to Jira' });
  await expect(apply).toBeDisabled();
  await expect(main(page)).toContainText(
    'Your Jira Service Management connection does not include ' +
      'read:servicedesk:jira-service-management, read:requesttype:jira-service-management, ' +
      'write:requesttype:jira-service-management. Reconnect it with “Set up request types” ticked'
  );
  await shot(page, testInfo, 'jira-admin-work-types-06-request-type-blocked');

  // Reconnected with the box: the same page now applies.
  await connectJiraServiceManagement(page, [...JSM_READ_SCOPES, ...JSM_REQUEST_TYPE_SCOPES]);
  await page.goto(`/jira-admin/changes/${id}`);
  await expect(apply).toBeEnabled();
  await apply.click();
  await expect(main(page).getByTestId('change-state')).toHaveText('Applied', { timeout: 30_000 });
  await expect(operations.nth(0)).toContainText(
    /Created as \d+\. Hidden on the portal until it is put in a portal group in Project settings\./
  );
  const requestTypes = values(
    await stub(person.subject, '/rest/servicedeskapi/servicedesk/3/requesttype')
  );
  expect(requestTypes).toHaveLength(1);
  expect(requestTypes[0]).toMatchObject({
    name: 'Report an outage',
    description: 'Something is down for everyone',
    issueTypeId: '10011',
  });
  await shot(page, testInfo, 'jira-admin-work-types-07-request-type-applied');
});
