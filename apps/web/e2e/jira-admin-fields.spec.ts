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
 * The proposal is seeded as the row jira_admin_propose_space_field writes
 * (its behavior is covered by field-tools.test.ts), the way
 * jira-admin-spaces.spec.ts seeds its proposals.
 *
 * Own tenant per project, and a fresh Jira site id per run: the stub keeps
 * each site's fields and screens in memory.
 *
 * Runs on the pinned Chromium only (no WebKit installed in this sandbox —
 * see voice.spec.ts's note); "mobile" is a resized viewport, per AGENTS.md.
 */

import { createCipheriv, createHash, randomBytes } from 'node:crypto';
import path from 'node:path';
import { test, expect, type Page, type TestInfo } from '@playwright/test';
import { Client } from 'pg';

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

/** `@renkei/crypto`'s secretbox, reproduced (see code.spec.ts). */
function secretbox(plaintext: string): string {
  const encoded = process.env.TOKEN_ENCRYPTION_KEY;
  if (!encoded) throw new Error('TOKEN_ENCRYPTION_KEY is not set');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(encoded, 'base64'), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return [
    'v1',
    iv.toString('base64'),
    cipher.getAuthTag().toString('base64'),
    ciphertext.toString('base64'),
  ].join('.');
}

function fixtureFor(projectName: string) {
  return {
    tenantId: uuidFrom(`jira-admin-fields-e2e-tenant:${projectName}`),
    sessionId: uuidFrom(`jira-admin-fields-e2e-session:${projectName}`),
    slug: `e2e-jira-fields-${projectName}`,
    subject: `e2e-jira-fields-${projectName}@example.com`,
    cloudId: `e2e-fields-${projectName}-${Date.now()}`,
  };
}

type Fixture = ReturnType<typeof fixtureFor>;

async function withDb<T>(work: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    return await work(client);
  } finally {
    await client.end();
  }
}

async function seedTenant(fixture: Fixture): Promise<void> {
  await withDb(async (client) => {
    const tenant = [fixture.tenantId];
    await client.query('DELETE FROM jira_admin_change_requests WHERE tenant_id = $1', tenant);
    await client.query('DELETE FROM audit_events WHERE tenant_id = $1', tenant);
    await client.query('DELETE FROM provider_grants WHERE tenant_id = $1', tenant);
    await client.query('DELETE FROM connector_configs WHERE tenant_id = $1', tenant);
    await client.query('DELETE FROM user_preferences WHERE tenant_id = $1', tenant);
    await client.query('DELETE FROM sessions WHERE tenant_id = $1', tenant);
    await client.query('DELETE FROM identities WHERE tenant_id = $1', tenant);
    await client.query('DELETE FROM tenants WHERE id = $1', tenant);
    await client.query('INSERT INTO tenants (id, slug) VALUES ($1, $2)', [
      fixture.tenantId,
      fixture.slug,
    ]);
    await client.query(
      `INSERT INTO sessions (id, tenant_id, subject, roles, expires_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        fixture.sessionId,
        fixture.tenantId,
        fixture.subject,
        ['renkei-user'],
        new Date(Date.now() + 24 * 3_600_000),
      ]
    );
    await client.query(
      `INSERT INTO identities (tenant_id, subject, email, display_name)
       VALUES ($1, $2, $3, $4)`,
      [fixture.tenantId, fixture.subject, fixture.subject, 'E2E Jira Admin']
    );
    await client.query(
      `INSERT INTO user_preferences (tenant_id, subject, key, value)
       VALUES ($1, $2, 'coach_marks', '{"autoStart": false}'::jsonb)`,
      [fixture.tenantId, fixture.subject]
    );
    await client.query(
      `INSERT INTO connector_configs (tenant_id, connector, enabled, encrypted_secrets, settings)
       VALUES ($1, 'atlassian-admin', true, 'not-a-real-secret', '{}'::jsonb)`,
      [fixture.tenantId]
    );
    await client.query(
      `INSERT INTO provider_grants
         (tenant_id, provider, provider_account_id, subject, client_id, display_name,
          encrypted_access_token, encrypted_refresh_token, expires_at, requested_scopes,
          metadata)
       VALUES ($1, 'atlassian-admin', 'e2e-jira-admin-account', $2, 'e2e-admin-client',
               'E2E Jira Admin', $3, $4, $5, $6, $7)`,
      [
        fixture.tenantId,
        fixture.subject,
        secretbox('e2e-admin-access-token'),
        secretbox('e2e-admin-refresh-token'),
        new Date(Date.now() + 365 * 24 * 3_600_000),
        [
          'read:jira-user',
          'read:jira-work',
          'manage:jira-configuration',
          'manage:jira-project',
          'offline_access',
        ],
        { cloudId: fixture.cloudId, siteUrl: 'https://e2e.atlassian.net' },
      ]
    );
  });
}

/** The row jira_admin_propose_space_field writes for a new Vendor select list in OPS. */
async function proposeVendor(fixture: Fixture): Promise<string> {
  const payload = {
    space: { id: '10000', key: 'OPS' },
    field: { id: null, name: 'Vendor', typeLabel: 'select list (single choice)' },
    operations: [
      { op: 'create_field', name: 'Vendor', description: 'Who supplies it', type: 'select' },
      { op: 'add_context', name: 'Vendor for OPS', issueTypes: [], options: ['Acme', 'Globex'] },
      {
        op: 'add_to_screen',
        screenId: '41',
        screenName: 'OPS: Create',
        tabId: '410',
        tabName: 'Field Tab',
        tabNote: null,
        uses: ['create'],
        sharedWith: [],
        moreShared: false,
      },
      {
        op: 'add_to_screen',
        screenId: '42',
        screenName: 'Shared bug screen',
        tabId: '420',
        tabName: 'Details',
        tabNote: null,
        uses: ['create', 'edit', 'view'],
        sharedWith: ['HR'],
        moreShared: false,
      },
    ],
  };
  const result = await withDb((client) =>
    client.query<{ id: string }>(
      `INSERT INTO jira_admin_change_requests
         (tenant_id, subject, cloud_id, site_url, kind, title, reason, payload, expires_at)
       VALUES ($1, $2, $3, 'https://e2e.atlassian.net', 'space_field',
               'New field “Vendor” for OPS', 'Procurement asked', $4, $5)
       RETURNING id`,
      [
        fixture.tenantId,
        fixture.subject,
        fixture.cloudId,
        JSON.stringify(payload),
        new Date(Date.now() + 24 * 3_600_000),
      ]
    )
  );
  const id = result.rows[0]?.id;
  if (!id) throw new Error('no change request inserted');
  return id;
}

/** GET from the stand-in Jira, as a record list. */
async function stub(fixture: Fixture, pathAndQuery: string): Promise<Record<string, unknown>[]> {
  const response = await fetch(`${STUB}/${fixture.cloudId}${pathAndQuery}`);
  const body: unknown = await response.json();
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
      name: `renkei_session_${fixture.tenantId}`,
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

test('a new field is reviewed with the screen another space shows, then created, scoped and placed', async ({
  page,
}, testInfo) => {
  const fixture = fixtureFor(testInfo.project.name);
  await seedTenant(fixture);
  const id = await proposeVendor(fixture);
  await signIn(page, fixture);

  // --- Reviewed: each step, and the screen HR shows too, in the warning colour. ---
  await page.goto(`/${fixture.slug}/jira-admin/changes/${id}`);
  await expect(page.getByRole('heading', { name: 'Review a Jira admin change' })).toBeVisible();
  await expect(main(page).getByTestId('change-title')).toHaveText('New field “Vendor” for OPS');
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
  expect(await stub(fixture, '/rest/api/3/field/search?query=Vendor')).toEqual([]);
  await shot(page, testInfo, 'jira-admin-fields-01-review');

  // --- Applied: the field, OPS's own context with its options, and each screen tab. ---
  await page.getByRole('button', { name: 'Apply these 4 changes to Jira' }).click();
  await expect(main(page).getByTestId('change-state')).toHaveText('Applied', { timeout: 30_000 });
  await expect(operations.nth(0)).toContainText(/Created as customfield_\d+\./);
  for (const index of [1, 2, 3]) {
    await expect(operations.nth(index)).toContainText('Done');
  }

  const fields = await stub(fixture, '/rest/api/3/field/search?query=Vendor');
  expect(fields).toHaveLength(1);
  const fieldId = String(fields[0]?.id);
  expect(fields[0]).toMatchObject({
    name: 'Vendor',
    description: 'Who supplies it',
    schema: { custom: 'com.atlassian.jira.plugin.system.customfieldtypes:select' },
    searcherKey: 'com.atlassian.jira.plugin.system.customfieldtypes:multiselectsearcher',
  });
  const mappings = await stub(fixture, `/rest/api/3/field/${fieldId}/context/projectmapping`);
  const own = mappings.find((mapping) => mapping.projectId === '10000');
  expect(own).toBeDefined();
  const options = await stub(
    fixture,
    `/rest/api/3/field/${fieldId}/context/${String(own?.contextId)}/option`
  );
  expect(options.map((option) => option.value)).toEqual(['Acme', 'Globex']);
  expect(await stub(fixture, '/rest/api/3/screens/41/tabs/410/fields')).toEqual([
    { id: fieldId, name: fieldId },
  ]);
  expect(await stub(fixture, '/rest/api/3/screens/42/tabs/420/fields')).toEqual([
    { id: fieldId, name: fieldId },
  ]);
  await expect
    .poll(async () =>
      withDb(async (client) => {
        const rows = await client.query(
          `SELECT 1 FROM audit_events WHERE tenant_id = $1 AND action = 'jira_admin.change_applied'`,
          [fixture.tenantId]
        );
        return rows.rowCount;
      })
    )
    .toBe(1);
  await shot(page, testInfo, 'jira-admin-fields-02-applied');

  // Mobile: a resized Chromium viewport, not a device descriptor.
  await page.setViewportSize(MOBILE_VIEWPORT);
  await noHorizontalOverflow(page);
  await shot(page, testInfo, 'jira-admin-fields-03-mobile');
});

test('a field of the same name made since stops it before a second is created', async ({
  page,
}, testInfo) => {
  const fixture = fixtureFor(testInfo.project.name);
  await seedTenant(fixture);
  const id = await proposeVendor(fixture);
  // Someone made a Vendor field by hand after the proposal.
  await fetch(`${STUB}/${fixture.cloudId}/rest/api/3/field`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: 'Vendor',
      type: 'com.atlassian.jira.plugin.system.customfieldtypes:textfield',
    }),
  });
  await signIn(page, fixture);

  await page.goto(`/${fixture.slug}/jira-admin/changes/${id}`);
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
  expect(await stub(fixture, '/rest/api/3/field/search?query=Vendor')).toHaveLength(1);
  expect(await stub(fixture, '/rest/api/3/screens/41/tabs/410/fields')).toEqual([]);
  await shot(page, testInfo, 'jira-admin-fields-04-name-taken');
});
