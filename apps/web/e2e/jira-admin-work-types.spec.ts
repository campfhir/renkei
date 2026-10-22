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
 * Each proposal is seeded as the row its jira_admin_propose_ tool writes
 * (the tools are covered by *-tools.test.ts), the way
 * jira-admin-fields.spec.ts seeds its proposal.
 *
 * Own person per project, and a fresh Jira site id per run: the stub keeps
 * each site's work types, screens and request types in memory.
 *
 * Runs on the pinned Chromium only (no WebKit installed in this sandbox —
 * see voice.spec.ts's note); "mobile" is a resized viewport, per AGENTS.md.
 */

import { createHash } from 'node:crypto';
import path from 'node:path';
import { test, expect, type Page, type TestInfo } from '@playwright/test';
import { Client } from 'pg';
import { sealForSubject } from './keys';

const RESULTS = path.join(import.meta.dirname, '..', 'test-results');
const MOBILE_VIEWPORT = { width: 390, height: 844 };
const STUB = 'http://127.0.0.1:8092/jira';

test.use({
  launchOptions: {
    executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    args: ['--no-sandbox'],
  },
});

function uuidFrom(seed: string): string {
  const hex = createHash('sha256').update(seed).digest('hex');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    `4${hex.slice(13, 16)}`,
    `8${hex.slice(17, 20)}`,
    hex.slice(20, 32),
  ].join('-');
}

function fixtureFor(projectName: string) {
  return {
    sessionId: uuidFrom(`jira-admin-work-types-e2e-session:${projectName}`),
    subject: `e2e-jira-work-types-${projectName}@example.com`,
    cloudId: `e2e-work-types-${projectName}-${Date.now()}`,
  };
}

type Fixture = ReturnType<typeof fixtureFor>;

const ADMIN_SCOPES = [
  'read:jira-user',
  'read:jira-work',
  'manage:jira-configuration',
  'manage:jira-project',
  'offline_access',
];

const JSM_READ_SCOPES = ['read:request:jira-service-management', 'offline_access'];
const JSM_SCOPES_WITH_BOX = [
  ...JSM_READ_SCOPES,
  'read:servicedesk:jira-service-management',
  'read:requesttype:jira-service-management',
  'write:requesttype:jira-service-management',
];

async function withDb<T>(work: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    return await work(client);
  } finally {
    await client.end();
  }
}

async function seedGrant(
  client: Client,
  fixture: Fixture,
  provider: 'atlassian-admin' | 'atlassian-jsm',
  scopes: string[]
): Promise<void> {
  await client.query(
    `INSERT INTO provider_grants
       (provider, provider_account_id, subject, client_id, display_name,
        encrypted_access_token, encrypted_refresh_token, expires_at, requested_scopes,
        metadata)
     VALUES ($1, $2, $3, $4, 'E2E Jira Admin', $5, $6, $7, $8, $9)`,
    [
      provider,
      `e2e-${provider}-account-${fixture.subject}`,
      fixture.subject,
      `e2e-${provider}-client`,
      await sealForSubject(client, fixture.subject, `e2e-${provider}-access-token`),
      await sealForSubject(client, fixture.subject, `e2e-${provider}-refresh-token`),
      new Date(Date.now() + 365 * 24 * 3_600_000),
      scopes,
      { cloudId: fixture.cloudId, siteUrl: 'https://e2e.atlassian.net' },
    ]
  );
}

async function seedTenant(fixture: Fixture, jsmScopes: string[] | null): Promise<void> {
  await withDb(async (client) => {
    await client.query('DELETE FROM jira_admin_change_requests WHERE subject = $1', [
      fixture.subject,
    ]);
    await client.query('DELETE FROM audit_events WHERE actor_subject = $1', [fixture.subject]);
    await client.query('DELETE FROM provider_grants WHERE subject = $1', [fixture.subject]);
    await client.query('DELETE FROM connector_configs');
    await client.query('DELETE FROM user_preferences WHERE subject = $1', [fixture.subject]);
    await client.query('DELETE FROM sessions WHERE subject = $1', [fixture.subject]);
    await client.query('DELETE FROM identities WHERE subject = $1', [fixture.subject]);
    await client.query(
      `INSERT INTO sessions (id, subject, roles, expires_at) VALUES ($1, $2, $3, $4)`,
      [fixture.sessionId, fixture.subject, ['renkei-user'], new Date(Date.now() + 24 * 3_600_000)]
    );
    await client.query(
      `INSERT INTO identities (subject, email, display_name) VALUES ($1, $2, $3)`,
      [fixture.subject, fixture.subject, 'E2E Jira Admin']
    );
    await client.query(
      `INSERT INTO user_preferences (subject, key, value)
       VALUES ($1, 'coach_marks', '{"autoStart": false}'::jsonb)`,
      [fixture.subject]
    );
    await client.query(
      `INSERT INTO connector_configs (connector, enabled, encrypted_secrets, settings)
       VALUES ('atlassian-admin', true, 'not-a-real-secret', '{}'::jsonb),
              ('atlassian-jsm', true, 'not-a-real-secret', '{}'::jsonb)`
    );
    await seedGrant(client, fixture, 'atlassian-admin', ADMIN_SCOPES);
    if (jsmScopes) await seedGrant(client, fixture, 'atlassian-jsm', jsmScopes);
  });
}

async function seedChange(
  fixture: Fixture,
  kind: string,
  title: string,
  payload: unknown
): Promise<string> {
  const result = await withDb((client) =>
    client.query<{ id: string }>(
      `INSERT INTO jira_admin_change_requests
         (subject, cloud_id, site_url, kind, title, reason, payload, expires_at)
       VALUES ($1, $2, 'https://e2e.atlassian.net', $3, $4, 'The on-call rota asked', $5, $6)
       RETURNING id`,
      [
        fixture.subject,
        fixture.cloudId,
        kind,
        title,
        JSON.stringify(payload),
        new Date(Date.now() + 24 * 3_600_000),
      ]
    )
  );
  const id = result.rows[0]?.id;
  if (!id) throw new Error('no change request inserted');
  return id;
}

/** The row jira_admin_propose_work_type writes for an Incident like Bug, in the scheme HR shares. */
function incidentPayload() {
  return {
    space: { id: '10000', key: 'OPS', serviceDesk: false },
    workType: { id: null, name: 'Incident', subtask: false },
    operations: [
      {
        op: 'create_work_type',
        name: 'Incident',
        description: 'Something is down',
        subtask: false,
      },
      { op: 'set_icon', avatarId: '10303', iconName: 'bug' },
      {
        op: 'add_to_scheme',
        schemeId: '11',
        schemeName: 'OPS work types',
        sharedWith: ['HR'],
        moreShared: false,
      },
      {
        op: 'map_screens',
        schemeId: '12',
        schemeName: 'OPS screens',
        screenSchemeId: '31',
        screenSchemeName: 'Bug screen scheme',
        likeName: 'Bug',
      },
      {
        op: 'map_workflow',
        schemeId: '13',
        schemeName: 'OPS workflows',
        workflowId: 'wf-bug',
        workflowName: 'Bug workflow',
        likeName: 'Bug',
      },
    ],
  };
}

/** The row jira_admin_propose_screen_changes writes for OPS's create screen. */
function screenPayload() {
  return {
    screen: { id: '41', name: 'OPS: Create' },
    spaces: ['OPS'],
    moreSpaces: false,
    operations: [
      {
        op: 'add_field',
        fieldId: 'priority',
        fieldName: 'Priority',
        tabId: '410',
        tabName: 'Field Tab',
      },
      {
        op: 'add_field',
        fieldId: 'customfield_10001',
        fieldName: 'Vendor',
        tabId: '410',
        tabName: 'Field Tab',
      },
      {
        op: 'remove_field',
        fieldId: 'priority',
        fieldName: 'Priority',
        tabId: '410',
        tabName: 'Field Tab',
      },
      { op: 'rename_tab', tabId: '410', from: 'Field Tab', to: 'Main' },
    ],
  };
}

/** The row jira_admin_propose_request_type writes for HELP's portal. */
function requestTypePayload() {
  return {
    serviceDesk: { id: '3', projectId: '10100', projectKey: 'HELP', projectName: 'Help desk' },
    operations: [
      {
        op: 'create_request_type',
        name: 'Report an outage',
        description: 'Something is down for everyone',
        helpText: null,
        workType: { id: '10011', name: 'Incident' },
      },
    ],
  };
}

/** GET from the stand-in Jira, as JSON. */
async function stub(fixture: Fixture, pathAndQuery: string): Promise<unknown> {
  const response = await fetch(`${STUB}/${fixture.cloudId}${pathAndQuery}`);
  return response.json();
}

function values(body: unknown): Record<string, unknown>[] {
  const list = Array.isArray(body)
    ? body
    : typeof body === 'object' && body !== null && 'values' in body && Array.isArray(body.values)
      ? body.values
      : [];
  return list.map((item: unknown) =>
    typeof item === 'object' && item !== null ? Object.fromEntries(Object.entries(item)) : {}
  );
}

async function signIn(page: Page, fixture: Fixture): Promise<void> {
  await page.context().addCookies([
    {
      name: `renkei_session`,
      value: fixture.sessionId,
      domain: '127.0.0.1',
      path: '/',
      httpOnly: true,
      secure: false,
      sameSite: 'Lax',
    },
  ]);
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

test.describe.configure({ mode: 'serial' });

test('a work type is reviewed with the scheme another space shares, then created, iconed and mapped', async ({
  page,
}, testInfo) => {
  const fixture = fixtureFor(testInfo.project.name);
  await seedTenant(fixture, null);
  const id = await seedChange(
    fixture,
    'work_type',
    'New work type “Incident” for OPS',
    incidentPayload()
  );
  await signIn(page, fixture);

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
  expect(values(await stub(fixture, '/rest/api/3/issuetype')).map((type) => type.name)).toEqual([
    'Task',
    'Bug',
  ]);
  await shot(page, testInfo, 'jira-admin-work-types-01-review');

  // --- Applied: the type with its icon, in the scheme, on Bug's screens and workflow. ---
  await page.getByRole('button', { name: 'Apply these 5 changes to Jira' }).click();
  await expect(main(page).getByTestId('change-state')).toHaveText('Applied', { timeout: 30_000 });
  await expect(operations.nth(0)).toContainText(/Created as \d+\./);
  for (const index of [1, 2, 3, 4]) {
    await expect(operations.nth(index)).toContainText('Done');
  }

  const types = values(await stub(fixture, '/rest/api/3/issuetype'));
  const incident = types.find((type) => type.name === 'Incident');
  expect(incident).toMatchObject({
    description: 'Something is down',
    avatarId: 10303,
    subtask: false,
  });
  const typeId = String(incident?.id);
  expect(
    values(await stub(fixture, '/rest/api/3/issuetypescheme/mapping?issueTypeSchemeId=11')).map(
      (item) => item.issueTypeId
    )
  ).toEqual(['10001', '10002', typeId]);
  expect(
    values(
      await stub(fixture, '/rest/api/3/issuetypescreenscheme/mapping?issueTypeScreenSchemeId=12')
    )
  ).toContainEqual(expect.objectContaining({ issueTypeId: typeId, screenSchemeId: '31' }));
  const schemes = await fetch(`${STUB}/${fixture.cloudId}/rest/api/3/workflowscheme/read`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ workflowSchemeIds: ['13'] }),
  }).then((response) => response.json());
  expect(values(schemes)[0]?.workflowsForIssueTypes).toEqual([
    { workflow: { id: 'wf-bug', name: 'Bug workflow' }, issueTypeIds: ['10002', typeId] },
  ]);
  await expect
    .poll(async () =>
      withDb(async (client) => {
        const rows = await client.query(
          `SELECT 1 FROM audit_events WHERE action = 'jira_admin.change_applied' AND actor_subject = $1`,
          [fixture.subject]
        );
        return rows.rowCount;
      })
    )
    .toBe(1);
  await shot(page, testInfo, 'jira-admin-work-types-02-applied');

  // Mobile: a resized Chromium viewport, not a device descriptor.
  await page.setViewportSize(MOBILE_VIEWPORT);
  await noHorizontalOverflow(page);
  await shot(page, testInfo, 'jira-admin-work-types-03-mobile');
});

test('changes to a screen are reviewed, then land on its tab in order', async ({
  page,
}, testInfo) => {
  const fixture = fixtureFor(testInfo.project.name);
  await seedTenant(fixture, null);
  const id = await seedChange(
    fixture,
    'screen_changes',
    '4 changes to the screen “OPS: Create”',
    screenPayload()
  );
  await signIn(page, fixture);

  await page.goto(`/jira-admin/changes/${id}`);
  await expect(main(page).getByTestId('change-title')).toHaveText(
    '4 changes to the screen “OPS: Create”'
  );
  const reach = main(page).getByTestId('change-reach');
  await expect(reach).toContainText('Only OPS shows it.');
  await expect(reach).not.toHaveClass(/bg-amber-50/);
  const operations = main(page).getByTestId('change-operations').locator(':scope > li');
  await expect(operations).toHaveCount(4);
  await expect(operations.nth(0)).toContainText('Put “Priority” on “OPS: Create”, tab “Field Tab”');
  await expect(operations.nth(2)).toContainText(
    'Take “Priority” off “OPS: Create”, tab “Field Tab”'
  );
  await expect(operations.nth(2).getByTestId('operation-details')).toContainText(
    'The field and its values on every issue stay; it is no longer shown here.'
  );
  await expect(operations.nth(3)).toContainText(
    'Rename the tab “Field Tab” of “OPS: Create” to “Main”'
  );
  await shot(page, testInfo, 'jira-admin-work-types-04-screen-review');

  await page.getByRole('button', { name: 'Apply these 4 changes to Jira' }).click();
  await expect(main(page).getByTestId('change-state')).toHaveText('Applied', { timeout: 30_000 });
  // Priority went on and came off again; Vendor stayed; the tab has its new name.
  expect(values(await stub(fixture, '/rest/api/3/screens/41/tabs/410/fields'))).toEqual([
    { id: 'customfield_10001', name: 'customfield_10001' },
  ]);
  expect(values(await stub(fixture, '/rest/api/3/screens/41/tabs'))).toEqual([
    { id: 410, name: 'Main' },
  ]);
  await shot(page, testInfo, 'jira-admin-work-types-05-screen-applied');
});

test('a request type waits for the JSM box, then applies on the JSM grant', async ({
  page,
}, testInfo) => {
  const fixture = fixtureFor(testInfo.project.name);
  // Connected to JSM, but without "Set up request types".
  await seedTenant(fixture, JSM_READ_SCOPES);
  const id = await seedChange(
    fixture,
    'request_type',
    'New request type “Report an outage” for HELP',
    requestTypePayload()
  );
  await signIn(page, fixture);

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
  await withDb(async (client) => {
    await client.query(
      `DELETE FROM provider_grants WHERE subject = $1 AND provider = 'atlassian-jsm'`,
      [fixture.subject]
    );
    await seedGrant(client, fixture, 'atlassian-jsm', JSM_SCOPES_WITH_BOX);
  });
  await page.reload();
  await expect(apply).toBeEnabled();
  await apply.click();
  await expect(main(page).getByTestId('change-state')).toHaveText('Applied', { timeout: 30_000 });
  await expect(operations.nth(0)).toContainText(
    /Created as \d+\. Hidden on the portal until it is put in a portal group in Project settings\./
  );
  const requestTypes = values(
    await stub(fixture, '/rest/servicedeskapi/servicedesk/3/requesttype')
  );
  expect(requestTypes).toHaveLength(1);
  expect(requestTypes[0]).toMatchObject({
    name: 'Report an outage',
    description: 'Something is down for everyone',
    issueTypeId: '10011',
  });
  await shot(page, testInfo, 'jira-admin-work-types-07-request-type-applied');
});
