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
 * The template and the proposal are seeded as the rows the tools write
 * (their behavior is covered by space-tools.test.ts), the way
 * jira-admin-changes.spec.ts seeds its proposals.
 *
 * Own tenant per project, and a fresh Jira site id per run: the stub keeps
 * each site's spaces in memory.
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
    tenantId: uuidFrom(`jira-admin-spaces-e2e-tenant:${projectName}`),
    sessionId: uuidFrom(`jira-admin-spaces-e2e-session:${projectName}`),
    slug: `e2e-jira-spaces-${projectName}`,
    subject: `e2e-jira-spaces-${projectName}@example.com`,
    cloudId: `e2e-spaces-${projectName}-${Date.now()}`,
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

const SCHEMES = {
  issueTypeScheme: { id: '11', name: 'OPS work types' },
  issueTypeScreenScheme: { id: '12', name: 'OPS screens' },
  workflowScheme: { id: '13', name: 'OPS workflows' },
  fieldConfigurationScheme: null,
  permissionScheme: { id: '15', name: 'Internal permissions' },
  notificationScheme: { id: '16', name: 'Quiet notifications' },
  issueSecurityScheme: null,
};

const ROLES = [
  {
    roleId: '10002',
    roleName: 'Administrators',
    groups: [{ groupId: 'g-admins', name: 'ops-admins' }],
  },
  {
    roleId: '10001',
    roleName: 'Developers',
    groups: [{ groupId: 'g-users', name: 'jira-software-users' }],
  },
];

const DANA = { accountId: 'acct-dana', displayName: 'Dana Admin' };

const COMPONENTS = [
  { name: 'Backend', description: 'Services and jobs', assigneeType: 'PROJECT_DEFAULT' },
  { name: 'Reports', description: null, assigneeType: 'PROJECT_LEAD' },
];

const ALL_SCOPES = [
  'read:jira-user',
  'read:jira-work',
  'manage:jira-configuration',
  'manage:jira-project',
  'offline_access',
];

async function seedTenant(fixture: Fixture, scopes = ALL_SCOPES): Promise<string> {
  return withDb(async (client) => {
    const tenant = [fixture.tenantId];
    await client.query('DELETE FROM jira_admin_change_requests WHERE tenant_id = $1', tenant);
    await client.query('DELETE FROM jira_admin_space_templates WHERE tenant_id = $1', tenant);
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
      `INSERT INTO user_preferences (tenant_id, subject, key, value)
       VALUES ($1, $2, 'connectors', '{"added": ["jira-admin"]}'::jsonb)`,
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
        scopes,
        { cloudId: fixture.cloudId, siteUrl: 'https://e2e.atlassian.net' },
      ]
    );
    // The row jira_admin_save_space_template writes.
    const template = await client.query<{ id: string }>(
      `INSERT INTO jira_admin_space_templates
         (tenant_id, cloud_id, site_url, name, name_key, description, source_space_key,
          document, created_by, updated_by)
       VALUES ($1, $2, 'https://e2e.atlassian.net', 'Ops standard', 'ops standard',
               'How operations spaces are set up', 'OPS', $3, $4, $4)
       RETURNING id`,
      [
        fixture.tenantId,
        fixture.cloudId,
        JSON.stringify({
          version: 1,
          projectTypeKey: 'software',
          assigneeType: 'UNASSIGNED',
          category: null,
          schemes: SCHEMES,
          roles: ROLES,
          components: COMPONENTS,
        }),
        fixture.subject,
      ]
    );
    const id = template.rows[0]?.id;
    if (!id) throw new Error('no template inserted');
    return id;
  });
}

/** The row jira_admin_propose_space writes. */
async function proposeSpace(
  fixture: Fixture,
  templateId: string,
  key: string,
  name: string
): Promise<string> {
  const payload = {
    source: { kind: 'template', id: templateId, name: 'Ops standard' },
    workflowUsage: { count: 2, more: false },
    operations: [
      {
        op: 'create_space',
        key,
        name,
        description: null,
        lead: DANA,
        projectTypeKey: 'software',
        assigneeType: 'UNASSIGNED',
        category: null,
        schemes: SCHEMES,
      },
      { op: 'add_role_members', ...ROLES[0], users: [DANA] },
      { op: 'add_role_members', ...ROLES[1], users: [] },
      { op: 'add_components', components: COMPONENTS },
      {
        op: 'add_versions',
        versions: [{ name: 'FY27', startDate: '2026-10-01', releaseDate: '2027-09-30' }],
      },
    ],
  };
  const result = await withDb((client) =>
    client.query<{ id: string }>(
      `INSERT INTO jira_admin_change_requests
         (tenant_id, subject, cloud_id, site_url, kind, title, payload, expires_at)
       VALUES ($1, $2, $3, 'https://e2e.atlassian.net', 'create_space', $4, $5, $6)
       RETURNING id`,
      [
        fixture.tenantId,
        fixture.subject,
        fixture.cloudId,
        `New space ${key} “${name}”, from template “Ops standard”`,
        JSON.stringify(payload),
        new Date(Date.now() + 24 * 3_600_000),
      ]
    )
  );
  const id = result.rows[0]?.id;
  if (!id) throw new Error('no change request inserted');
  return id;
}

/** A space as the stand-in Jira holds it, or null. */
async function stubSpace(fixture: Fixture, key: string): Promise<Record<string, unknown> | null> {
  const response = await fetch(`${STUB}/${fixture.cloudId}/rest/api/3/project/${key}`);
  if (!response.ok) return null;
  const body: unknown = await response.json();
  return typeof body === 'object' && body !== null
    ? Object.fromEntries(Object.entries(body))
    : null;
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

test('a template’s new space is reviewed scheme by scheme, then created with its roles', async ({
  page,
}, testInfo) => {
  const fixture = fixtureFor(testInfo.project.name);
  const templateId = await seedTenant(fixture);
  const id = await proposeSpace(fixture, templateId, 'FIN', 'Finance');
  await signIn(page, fixture);

  // --- The organization's templates, from the Jira Administration card. ---
  await page.goto(`/${fixture.slug}/connectors`);
  const card = page.locator('[data-coach="card-jira-admin"]');
  await card.getByTestId('jira-admin-templates-link').click();
  // A client-side navigation to a route that may compile on first visit.
  await expect(page).toHaveURL(new RegExp(`/${fixture.slug}/jira-admin/templates$`), {
    timeout: 30_000,
  });
  const templateCard = main(page).getByTestId('space-template');
  await expect(templateCard).toHaveCount(1);
  await expect(templateCard).toContainText('Ops standard');
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
  await page.goto(`/${fixture.slug}/jira-admin/changes/${id}`);
  await expect(page.getByRole('heading', { name: 'Review a Jira admin change' })).toBeVisible();
  await expect(main(page).getByTestId('change-reach')).toHaveText(
    'Where: A new space FIN on https://e2e.atlassian.net, running on the same schemes as ' +
      'template “Ops standard” rather than copies of them — a later change to one of those ' +
      'schemes changes every space on it.'
  );
  const operations = main(page).getByTestId('change-operations').locator(':scope > li');
  await expect(operations).toHaveCount(5);
  await expect(operations.nth(0)).toContainText(
    'Create the software space FIN — “Finance” — led by Dana Admin, on the schemes of ' +
      'template “Ops standard”'
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
  expect(await stubSpace(fixture, 'FIN')).toBeNull();
  await shot(page, testInfo, 'jira-admin-spaces-02-review');

  // --- Applied: the space exists on the stored schemes, its roles filled once. ---
  await page.getByRole('button', { name: 'Apply these 5 changes to Jira' }).click();
  await expect(main(page).getByTestId('change-state')).toHaveText('Applied', { timeout: 30_000 });
  await expect(operations).toHaveCount(5);
  await expect(operations.nth(0)).toContainText('Done');
  await expect(operations.nth(0)).toContainText('https://e2e.atlassian.net/browse/FIN');
  // Jira's default put ops-admins in already; only Dana was added.
  await expect(operations.nth(1)).toContainText('1 already in the role.');
  await expect(operations.nth(2)).toContainText('Done');
  await expect(operations.nth(3)).toContainText('Done');
  await expect(operations.nth(4)).toContainText('Done');

  const created = await stubSpace(fixture, 'FIN');
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
  await shot(page, testInfo, 'jira-admin-spaces-03-applied');

  // Mobile: a resized Chromium viewport, not a device descriptor.
  await page.setViewportSize(MOBILE_VIEWPORT);
  await noHorizontalOverflow(page);
  await page.goto(`/${fixture.slug}/jira-admin/templates`);
  await expect(main(page).getByTestId('space-template')).toHaveCount(1);
  await noHorizontalOverflow(page);
  await shot(page, testInfo, 'jira-admin-spaces-04-mobile');
});

test('a key taken since the proposal stops it before anything is created', async ({
  page,
}, testInfo) => {
  const fixture = fixtureFor(testInfo.project.name);
  const templateId = await seedTenant(fixture);
  const id = await proposeSpace(fixture, templateId, 'TAKEN', 'Finance');
  // Someone made TAKEN by hand after the proposal.
  await fetch(`${STUB}/${fixture.cloudId}/rest/api/3/project`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ key: 'TAKEN', name: 'Made by hand' }),
  });
  await signIn(page, fixture);

  await page.goto(`/${fixture.slug}/jira-admin/changes/${id}`);
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
  const space = await stubSpace(fixture, 'TAKEN');
  expect(space?.name).toBe('Made by hand');
  await shot(page, testInfo, 'jira-admin-spaces-05-key-taken');
});

test('a new space with components waits for a connection that can add them', async ({
  page,
}, testInfo) => {
  const fixture = fixtureFor(testInfo.project.name);
  // Connected before the components permission existed.
  const templateId = await seedTenant(
    fixture,
    ALL_SCOPES.filter((scope) => scope !== 'manage:jira-project')
  );
  const id = await proposeSpace(fixture, templateId, 'FIN', 'Finance');
  await signIn(page, fixture);

  await page.goto(`/${fixture.slug}/jira-admin/changes/${id}`);
  await expect(
    main(page).getByText(
      'Your Jira Administration connection does not include manage:jira-project. Reconnect ' +
        'it with Space components, versions and screens ticked (if it is not offered, an ' +
        'organization admin allows it under Connector setup first).'
    )
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Apply these 5 changes to Jira' })).toBeDisabled();
  expect(await stubSpace(fixture, 'FIN')).toBeNull();
  await shot(page, testInfo, 'jira-admin-spaces-06-needs-reconnect');
});
