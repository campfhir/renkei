/**
 * Salesforce Admin, end to end in a browser, up to Salesforce itself.
 *
 * An operator adds two admin connectors through the real admin form and
 * save route: a UAT sandbox, and production with change requests left off
 * (the safe default). A person sees one admin card per org beside nothing
 * of the CRM's, and the sandbox's connect link turns into a PKCE consent
 * redirect to its own My Domain with its own consumer key, the pending row
 * naming the admin provider and the connector.
 *
 * Then three change requests as a proposal stores them — the rows a
 * salesforce_admin_propose_* tool writes after Salesforce's check-only
 * deploy — and their review pages: a validated one shows every component
 * and the permission grants that follow, with Deploy on; one whose
 * validation failed lists Salesforce's errors with Deploy off; one in the
 * production org says why that org takes no changes. Cancelling uses the
 * real cancel route; the list page and the card count follow.
 *
 * Nothing here reaches Salesforce: no org answers in this environment, and
 * the delegate lets an admin token travel only to its own org's host, so
 * the deploy itself (quick deploy, full deploy, field grants) is covered by
 * lib/salesforce-admin/apply.test.ts against a fake org.
 *
 * Own person, and only its own connector_configs row (`salesforce-admin`):
 * run its projects one at a time (--workers=1).
 *
 * Runs on the pinned Chromium only; "mobile" is a resized viewport, per AGENTS.md.
 */

import { createHash } from 'node:crypto';
import path from 'node:path';
import { test, expect, type Page, type TestInfo } from './worker-env';
import { Client } from 'pg';
import { enrollForE2E } from './keys';
import { isolateFile } from './worker-env';

// Each file starts from a database of its own: this runs before the file's other hooks.
test.beforeAll(isolateFile);


const RESULTS = path.join(import.meta.dirname, '..', 'test-results');
const MOBILE_VIEWPORT = { width: 390, height: 844 };
const PRODUCTION = 'acme-e2e-admin.my.salesforce.com';
const UAT = 'acme-e2e-admin--uat.sandbox.my.salesforce.com';
const ORG_ID = '00D000000000062EAA';

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
    sessionId: uuidFrom(`salesforce-admin-e2e-session:${projectName}`),
    subject: `e2e-salesforce-admin-${projectName}@example.com`,
    validated: uuidFrom(`salesforce-admin-e2e-validated:${projectName}`),
    failed: uuidFrom(`salesforce-admin-e2e-failed:${projectName}`),
    production: uuidFrom(`salesforce-admin-e2e-production:${projectName}`),
    access: uuidFrom(`salesforce-admin-e2e-access:${projectName}`),
    picklist: uuidFrom(`salesforce-admin-e2e-picklist:${projectName}`),
    // Not an operator: may ask for a change in words, may not approve one.
    askerSessionId: uuidFrom(`salesforce-admin-e2e-asker-session:${projectName}`),
    askerSubject: `e2e-salesforce-admin-asker-${projectName}@example.com`,
    request: uuidFrom(`salesforce-admin-e2e-request:${projectName}`),
    running: uuidFrom(`salesforce-admin-e2e-running:${projectName}`),
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

async function clear(client: Client, fixture: Fixture): Promise<void> {
  await client.query('DELETE FROM provider_grants WHERE subject = $1', [fixture.subject]);
  await client.query('DELETE FROM salesforce_admin_change_requests WHERE subject = ANY($1)', [
    [fixture.subject, fixture.askerSubject],
  ]);
  await client.query('DELETE FROM sessions WHERE subject = $1', [fixture.askerSubject]);
  await client.query('DELETE FROM identities WHERE subject = $1', [fixture.askerSubject]);
  await client.query('DELETE FROM agent_notifications WHERE subject = ANY($1)', [
    [fixture.subject, fixture.askerSubject],
  ]);
  await client.query(`DELETE FROM connector_configs WHERE connector = 'salesforce-admin'`);
}

async function seedPerson(fixture: Fixture): Promise<void> {
  await withDb(async (client) => {
    await clear(client, fixture);
    for (const table of ['pending_oidc_signin', 'user_preferences', 'sessions', 'identities']) {
      await client.query(`DELETE FROM ${table} WHERE subject = $1`, [fixture.subject]);
    }
    await client.query(
      `INSERT INTO sessions (id, subject, roles, expires_at) VALUES ($1, $2, $3, $4)`,
      [
        fixture.sessionId,
        fixture.subject,
        ['renkei-user', 'renkei-operator'],
        new Date(Date.now() + 24 * 3_600_000),
      ]
    );
    await client.query(
      `INSERT INTO identities (subject, email, display_name) VALUES ($1, $2, $3)`,
      [fixture.subject, fixture.subject, 'E2E Tester']
    );
    await client.query(
      `INSERT INTO user_preferences (subject, key, value) VALUES ($1, 'coach_marks', '{"autoStart": false}'::jsonb)`,
      [fixture.subject]
    );
    await client.query(
      `INSERT INTO user_preferences (subject, key, value) VALUES ($1, 'connectors', '{"added": ["salesforce-admin"]}'::jsonb)`,
      [fixture.subject]
    );
    await enrollForE2E(client, fixture.subject);
  });
}

/** The row the OAuth callback writes once the UAT sandbox sends the person back. */
async function connect(fixture: Fixture, connector: string, host: string): Promise<void> {
  await withDb((client) =>
    client.query(
      `INSERT INTO provider_grants
         (provider, provider_account_id, subject, client_id, display_name,
          encrypted_access_token, encrypted_refresh_token, expires_at, requested_scopes, metadata)
       VALUES ('salesforce-admin', $1, $2, $3, 'Ada Admin',
               'not-a-real-token', 'not-a-real-token', $4, $5, $6)`,
      [
        `${ORG_ID}/005000000000001AAA-${connector}-${fixture.subject}`,
        fixture.subject,
        `e2e-admin-${connector}-client`,
        new Date(Date.now() + 3_600_000),
        ['sfa-read', 'sfa-schema'],
        {
          orgId: ORG_ID,
          userId: '005000000000001AAA',
          instanceUrl: `https://${host}`,
          username: 'ada@acme.org',
          connector,
        },
      ]
    )
  );
}

/** A change request as salesforce_admin_propose_fields stores it after Salesforce's check-only deploy. */
async function propose(
  fixture: Fixture,
  input: {
    id: string;
    connector: string;
    host: string;
    validation: Record<string, unknown>;
    kind?: string;
    title?: string;
    payload?: Record<string, unknown>;
  }
): Promise<void> {
  const payload = input.payload ?? {
    files: {
      'package.xml': '<Package/>',
      'objects/Site_Visit__c.object': '<CustomObject/>',
    },
    members: [{ type: 'CustomField', member: 'Site_Visit__c.Outcome__c' }],
    components: [
      {
        type: 'CustomField',
        name: 'Site_Visit__c.Outcome__c',
        action: 'create',
        rows: [
          { label: 'Label', value: 'Outcome' },
          { label: 'Type', value: 'Picklist' },
          { label: 'Values', value: 'Completed, No show' },
        ],
      },
    ],
    preconditions: [{ kind: 'field-absent', object: 'Site_Visit__c', field: 'Outcome__c' }],
    fieldGrants: [
      {
        permissionSetId: '0PS000000000001AAA',
        permissionSetName: 'Program_Staff',
        object: 'Site_Visit__c',
        field: 'Outcome__c',
        edit: true,
      },
    ],
  };
  await withDb((client) =>
    client.query(
      `INSERT INTO salesforce_admin_change_requests
         (id, subject, connector_key, org_id, instance_url, kind, title, reason, payload, validation, expires_at)
       VALUES ($1, $2, $3, $4, $5, $9, $6, 'The program tracks outcomes now', $7, $8, NOW() + INTERVAL '1 day')`,
      [
        input.id,
        fixture.subject,
        input.connector,
        ORG_ID,
        `https://${input.host}`,
        input.title ?? `Site Visit: add the field Outcome (${input.connector})`,
        JSON.stringify(payload),
        JSON.stringify({ checkedAt: new Date().toISOString(), ...input.validation }),
        input.kind ?? 'fields',
      ]
    )
  );
}

async function signIn(page: Page, fixture: Fixture): Promise<void> {
  await page.context().addCookies([
    {
      name: 'renkei_session',
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

async function addOrg(
  page: Page,
  values: { name: string; domain: string; clientId: string; sandbox: boolean }
): Promise<void> {
  const form = page.locator('[data-coach="admin-connector-form"]');
  await form.locator('#salesforce-admin-new-name').fill(values.name);
  await form.locator('#salesforce-admin-new-domain').fill(values.domain);
  const sandbox = form.getByRole('checkbox', { name: 'This is a sandbox' });
  if ((await sandbox.isChecked()) !== values.sandbox) await sandbox.click();
  await form.locator('#salesforce-admin-new-client-id').fill(values.clientId);
  await form.locator('#salesforce-admin-new-client-secret').fill(`${values.clientId}-secret`);
  await form.getByRole('button', { name: 'Save' }).click();
}

// eslint-disable-next-line no-empty-pattern -- Playwright needs the fixtures object first
test.afterEach(async ({}, testInfo) => {
  await withDb((client) => clear(client, fixtureFor(testInfo.project.name)));
});

test('salesforce admin: per-org connectors, connect, and change requests up to the deploy', async ({
  page,
}, testInfo) => {
  test.setTimeout(180_000);
  const fixture = fixtureFor(testInfo.project.name);
  await seedPerson(fixture);
  await signIn(page, fixture);

  // --- The operator adds a sandbox to build in, and production left read only. ---
  await page.goto('/admin/connectors/salesforce-admin');
  await expect(page.getByRole('heading', { name: 'Salesforce Admin', level: 1 })).toBeVisible();
  const form = page.locator('[data-coach="admin-connector-form"]');
  await expect(form.getByText('No Salesforce Admin connectors yet.')).toBeVisible();
  await form.getByRole('button', { name: 'Add your first org' }).click();
  // Building usually starts in a sandbox.
  await expect(form.getByRole('checkbox', { name: 'This is a sandbox' })).toBeChecked();
  // The CRM's "kept away" fields are not the admin connector's.
  await expect(form.getByText('Kept away from the assistant')).toHaveCount(0);
  await addOrg(page, { name: 'UAT', domain: UAT, clientId: 'e2e-admin-uat-client', sandbox: true });
  await expect(form.getByRole('heading', { name: 'Salesforce Admin · UAT' })).toBeVisible({
    timeout: 30_000,
  });
  await expect(form.getByText('Applied here when the person approves them')).toBeVisible();

  await form.getByRole('button', { name: 'Add a Salesforce org' }).click();
  await form.getByRole('checkbox', { name: 'This is a sandbox' }).uncheck();
  // Production takes no change requests until an admin says so.
  const allow = form.getByRole('checkbox', {
    name: /Allow change requests in this production org/,
  });
  await expect(allow).not.toBeChecked();
  await addOrg(page, {
    name: 'Production',
    domain: PRODUCTION,
    clientId: 'e2e-admin-production-client',
    sandbox: false,
  });
  await expect(form.getByRole('heading', { name: 'Salesforce Admin · Production' })).toBeVisible({
    timeout: 30_000,
  });
  await expect(form.getByText('Not in this production org — read only')).toBeVisible();
  await shot(page, testInfo, 'salesforce-admin-01-registered');

  const stored = await withDb((client) =>
    client.query<{
      settings: {
        orgs?: { key: string; sandbox: boolean; productionChanges?: boolean; scopes: string }[];
      };
    }>(`SELECT settings FROM connector_configs WHERE connector = 'salesforce-admin'`)
  );
  expect(
    (stored.rows[0]?.settings.orgs ?? []).map((org) => [
      org.key,
      org.sandbox,
      org.productionChanges,
    ])
  ).toEqual([
    ['uat', true, false],
    ['production', false, false],
  ]);
  // User access (assigning permission sets to people) is off unless chosen.
  expect(stored.rows[0]?.settings.orgs?.[0]?.scopes.split(' ').sort()).toEqual([
    'sfa-layouts',
    'sfa-permissions',
    'sfa-read',
    'sfa-schema',
  ]);

  // --- The person's cards: one per org, and the sandbox's connect link. ---
  await page.goto('/connectors');
  const cards = page.locator('[data-coach="card-salesforce-admin"]');
  await expect(cards).toHaveCount(2, { timeout: 90_000 });
  const uat = cards.filter({ has: page.getByRole('heading', { name: /Salesforce Admin · UAT/ }) });
  await expect(uat.getByText('Sandbox', { exact: true })).toBeVisible();
  const connectLink = uat.getByRole('link', { name: 'Connect Salesforce Admin · UAT' });
  const href = await connectLink.getAttribute('href');
  expect(href).toMatch(/^\/api\/salesforce-admin\/uat\/authorize/);
  const authorize = await page.request.get(href ?? '', { maxRedirects: 0 });
  expect([302, 307]).toContain(authorize.status());
  const consent = new URL(authorize.headers()['location'] ?? '');
  expect(consent.origin + consent.pathname).toBe(`https://${UAT}/services/oauth2/authorize`);
  expect(consent.searchParams.get('client_id')).toBe('e2e-admin-uat-client');
  const pending = await withDb((client) =>
    client.query<{ provider: string; connector_key: string; scopes: string }>(
      `SELECT provider, connector_key, scopes FROM pending_oidc_signin WHERE state = $1`,
      [consent.searchParams.get('state')]
    )
  );
  expect(pending.rows[0]).toMatchObject({ provider: 'salesforce-admin', connector_key: 'uat' });

  // --- Connected to both; three proposals as the tools store them. ---
  await connect(fixture, 'uat', UAT);
  await connect(fixture, 'production', PRODUCTION);
  const passed = {
    deployId: '0Af000000000001AAA',
    done: true,
    success: true,
    status: 'Succeeded',
    failures: [],
  };
  await propose(fixture, {
    id: fixture.validated,
    connector: 'uat',
    host: UAT,
    validation: passed,
  });
  await propose(fixture, {
    id: fixture.failed,
    connector: 'uat',
    host: UAT,
    validation: {
      deployId: '0Af000000000002AAA',
      done: true,
      success: false,
      status: 'Failed',
      failures: [
        {
          type: 'CustomField',
          name: 'Site_Visit__c.Outcome__c',
          problem: 'Picklist value too long',
        },
      ],
    },
  });
  // A standard picklist's values and what a record type offers of them, in one change.
  await propose(fixture, {
    id: fixture.picklist,
    connector: 'uat',
    host: UAT,
    kind: 'picklist_changes',
    title: 'Lead: change the values of Lead.LeadSource',
    validation: passed,
    payload: {
      files: { 'package.xml': '<Package/>' },
      members: [
        { type: 'StandardValueSet', member: 'LeadSource' },
        { type: 'RecordType', member: 'Lead.Donor' },
      ],
      components: [
        {
          type: 'StandardValueSet',
          name: 'LeadSource',
          action: 'update',
          rows: [{ label: 'Add value', value: 'Webinar' }],
        },
        {
          type: 'RecordType',
          name: 'Lead.Donor',
          action: 'update',
          rows: [{ label: 'Offer', value: 'Webinar' }],
        },
      ],
      preconditions: [],
      dataSteps: [],
    },
  });
  // Access added to an existing permission set: data only, nothing to deploy.
  await propose(fixture, {
    id: fixture.access,
    connector: 'uat',
    host: UAT,
    kind: 'permission_set',
    title: 'Program_Staff: more access',
    validation: { deployId: '', done: true, success: true, status: 'Checked', failures: [] },
    payload: {
      files: {},
      members: [],
      components: [
        {
          type: 'PermissionSet',
          name: 'Program_Staff',
          action: 'update',
          rows: [{ label: 'Site_Visit__c records', value: 'read, edit', from: 'read' }],
        },
      ],
      preconditions: [],
      dataSteps: [
        {
          kind: 'object-permission',
          permissionSetId: '0PS000000000001AAA',
          permissionSetName: 'Program_Staff',
          object: 'Site_Visit__c',
          read: true,
          create: false,
          edit: true,
          delete: false,
          viewAll: false,
          modifyAll: false,
        },
        {
          kind: 'tab-visibility',
          permissionSetId: '0PS000000000001AAA',
          permissionSetName: 'Program_Staff',
          tab: 'Site_Visit__c',
          visibility: 'DefaultOn',
        },
      ],
    },
  });
  await propose(fixture, {
    id: fixture.production,
    connector: 'production',
    host: PRODUCTION,
    validation: passed,
  });

  await page.reload();
  await expect(uat.getByText('Connected', { exact: true })).toBeVisible();
  // Counted per org: four wait in UAT, one in production.
  await expect(
    uat.getByRole('link', { name: '4 change requests waiting for review' })
  ).toBeVisible();
  const production = cards.filter({
    has: page.getByRole('heading', { name: /Salesforce Admin · Production/ }),
  });
  await expect(
    production.getByRole('link', { name: '1 change request waiting for review' })
  ).toBeVisible();
  await expect(production.getByText('This production org is read only here')).toBeVisible();
  await shot(page, testInfo, 'salesforce-admin-02-cards');

  // --- A validated request: every component, the grants that follow, Deploy on. ---
  await page.goto(`/salesforce-admin/changes/${fixture.validated}`);
  await expect(page.getByRole('heading', { name: 'Review a Salesforce change' })).toBeVisible();
  await expect(page.getByRole('main').getByTestId('change-state')).toHaveText('Waiting for review');
  await expect(page.getByRole('main').getByTestId('validation-state')).toHaveText(
    'Validated by Salesforce'
  );
  await expect(page.getByRole('main').getByTestId('change-org')).toContainText('UAT (sandbox)');
  const components = page.getByRole('main').getByTestId('change-components');
  await expect(components.getByText('Site_Visit__c.Outcome__c')).toBeVisible();
  await expect(components.getByText('New field')).toBeVisible();
  await expect(components.getByText('Completed, No show')).toBeVisible();
  await expect(page.getByRole('main').getByTestId('change-grants')).toContainText(
    'Then, once it deploys:'
  );
  await expect(page.getByRole('main').getByTestId('change-grants')).toContainText(
    'Give Program_Staff read and edit access to Site_Visit__c.Outcome__c'
  );
  await expect(page.getByRole('button', { name: 'Deploy to UAT' })).toBeEnabled();
  await shot(page, testInfo, 'salesforce-admin-03-review');

  // Mobile: a resized Chromium viewport, not a device descriptor.
  await page.setViewportSize(MOBILE_VIEWPORT);
  await expect(page.getByRole('button', { name: 'Deploy to UAT' })).toBeVisible();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth
  );
  expect(overflow).toBeLessThanOrEqual(0);
  await shot(page, testInfo, 'salesforce-admin-04-review-mobile');
  await page.setViewportSize({ width: 1280, height: 900 });

  // --- Access added to a permission set: old against new, steps, Apply (nothing deploys). ---
  await page.goto(`/salesforce-admin/changes/${fixture.access}`);
  await expect(page.getByRole('main').getByTestId('validation-state')).toHaveText(
    'Checked against the org'
  );
  await expect(page.getByRole('heading', { name: 'Checks' })).toBeVisible();
  await expect(page.getByText(/Nothing in this change deploys/)).toBeVisible();
  await expect(page.getByRole('heading', { name: 'What applying it changes' })).toBeVisible();
  const access = page.getByRole('main').getByTestId('change-components');
  await expect(access.getByText('Changed permission set')).toBeVisible();
  await expect(access.getByText('read, edit', { exact: true })).toBeVisible();
  await expect(access.getByText('read', { exact: true })).toBeVisible();
  const steps = page.getByRole('main').getByTestId('change-grants');
  await expect(steps).toContainText('What applying it does:');
  await expect(steps).toContainText(
    'Give Program_Staff read, edit access to Site_Visit__c records'
  );
  await expect(steps).toContainText(
    'Show the Site_Visit__c tab to Program_Staff (in their navigation by default)'
  );
  await expect(page.getByRole('button', { name: 'Apply in UAT' })).toBeEnabled();
  await expect(page.getByRole('button', { name: /deploy to/i })).toHaveCount(0);
  await shot(page, testInfo, 'salesforce-admin-04b-access');
  await page.setViewportSize(MOBILE_VIEWPORT);
  await expect(page.getByRole('button', { name: 'Apply in UAT' })).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth
    )
  ).toBeLessThanOrEqual(0);
  await shot(page, testInfo, 'salesforce-admin-04c-access-mobile');
  await page.setViewportSize({ width: 1280, height: 900 });

  // --- A standard picklist and a record type: each component named for what it is. ---
  await page.goto(`/salesforce-admin/changes/${fixture.picklist}`);
  const picklist = page.getByRole('main').getByTestId('change-components');
  await expect(picklist.getByText('Changed standard picklist')).toBeVisible();
  await expect(picklist.getByText('Changed record type')).toBeVisible();
  await expect(picklist.getByText('Offer', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Deploy to UAT' })).toBeEnabled();
  await shot(page, testInfo, 'salesforce-admin-04d-picklist');

  // --- A failed validation: Salesforce's errors, and no Deploy. ---
  await page.goto(`/salesforce-admin/changes/${fixture.failed}`);
  await expect(page.getByRole('main').getByTestId('validation-state')).toHaveText(
    'Validation failed'
  );
  await expect(page.getByRole('main').getByTestId('change-validation')).toContainText(
    'Picklist value too long'
  );
  await expect(page.getByRole('button', { name: 'Deploy to UAT' })).toBeDisabled();
  await expect(page.getByText(/Salesforce has not validated this change/)).toBeVisible();

  // Declining it is the real cancel route.
  await page.getByRole('button', { name: 'Decline it' }).click();
  await page.getByRole('button', { name: 'Send the decline' }).click();
  await expect(page.getByRole('main').getByTestId('change-state')).toHaveText('Cancelled', {
    timeout: 30_000,
  });

  // --- Production takes no change requests: the gate says why, before the click. ---
  await page.goto(`/salesforce-admin/changes/${fixture.production}`);
  await expect(page.getByRole('main').getByTestId('change-org')).toContainText(
    'Production — production'
  );
  await expect(
    page.getByText(/is a production org that does not take change requests/)
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Deploy to Production' })).toBeDisabled();
  // And the route refuses it too, whatever the page shows.
  const refused = await page.request.post(
    `/api/salesforce-admin/changes/${fixture.production}/apply`
  );
  expect(refused.status()).toBe(403);

  // --- The list: four waiting, one cancelled. ---
  await page.goto('/salesforce-admin/changes');
  await expect(page.getByRole('heading', { name: 'Salesforce admin changes' })).toBeVisible();
  await expect(page.getByRole('main').getByTestId('changes-waiting').getByRole('link')).toHaveCount(
    4
  );
  await expect(page.getByRole('main').getByTestId('changes-recent').getByRole('link')).toHaveCount(
    1
  );
  await expect(page.getByText('Site Visit: add the field Outcome (production)')).toBeVisible();
  await shot(page, testInfo, 'salesforce-admin-05-list');

  // Someone else's request is not found, not forbidden.
  const stranger = await page.request.post(
    `/api/salesforce-admin/changes/${uuidFrom('nobody')}/apply`
  );
  expect(stranger.status()).toBe(404);

  // --- Asking without approving rights, and a deploy running on the server. ---
  await withDb(async (client) => {
    await client.query(
      `INSERT INTO sessions (id, subject, roles, expires_at) VALUES ($1, $2, $3, $4)`,
      [
        fixture.askerSessionId,
        fixture.askerSubject,
        ['renkei-user'],
        new Date(Date.now() + 24 * 3_600_000),
      ]
    );
    await client.query(
      `INSERT INTO identities (subject, email, display_name) VALUES ($1, $2, $3)`,
      [fixture.askerSubject, fixture.askerSubject, 'Arlo Asker']
    );
    // Enrolled, so the write-down dialog does not cover the page.
    await enrollForE2E(client, fixture.askerSubject);
    // What salesforce_admin_request_change stores: words, no package.
    await client.query(
      `INSERT INTO salesforce_admin_change_requests
         (id, subject, connector_key, org_id, instance_url, kind, title, reason, payload, expires_at)
       VALUES ($1, $2, 'uat', $3, $4, 'request', 'Add an Outcome picklist to Site Visit',
               'The program tracks outcomes now', $5, NOW() + INTERVAL '1 day')`,
      [
        fixture.request,
        fixture.askerSubject,
        ORG_ID,
        `https://${UAT}`,
        JSON.stringify({ description: 'Site_Visit__c needs Outcome__c: Completed, No show.' }),
      ]
    );
    // What the job leaves while a deploy runs: approved, applying, its latest step.
    await client.query(
      `INSERT INTO salesforce_admin_change_requests
         (id, subject, connector_key, org_id, instance_url, kind, title, payload, validation,
          status, step, approved_by, approved_at, results, expires_at)
       VALUES ($1, $2, 'uat', $3, $4, 'fields', 'Site Visit: add the field Notes (running)',
               '{"files":{},"members":[],"components":[],"preconditions":[],"dataSteps":[]}'::jsonb,
               $5, 'applying', 'Salesforce is deploying — 2 of 5 components (InProgress)', $6, NOW(),
               '{"deployId":"0Af000000000009AAA","operations":[]}'::jsonb, NOW() + INTERVAL '1 day')`,
      [
        fixture.running,
        fixture.askerSubject,
        ORG_ID,
        `https://${UAT}`,
        JSON.stringify({
          checkedAt: new Date().toISOString(),
          deployId: '0Af000000000008AAA',
          done: true,
          success: true,
          status: 'Succeeded',
          failures: [],
        }),
        fixture.subject,
      ]
    );
  });

  // The operator sees the running deploy and how far it is, and who asked.
  await page.goto('/salesforce-admin/changes');
  const runningList = page.getByRole('main').getByTestId('changes-running');
  const runningRow = runningList.getByRole('link', { name: /add the field Notes/ });
  await expect(runningRow).toContainText('Salesforce is deploying — 2 of 5 components');
  await expect(runningRow).toContainText('by Arlo Asker');
  await shot(page, testInfo, 'salesforce-admin-06-running-list');
  await runningRow.click();
  const progress = page.getByRole('main').getByTestId('change-progress');
  await expect(progress).toContainText('Deploying', { timeout: 30_000 });
  await expect(page.getByRole('main').getByTestId('change-step')).toHaveText(
    'Salesforce is deploying — 2 of 5 components (InProgress)'
  );
  await expect(progress).toContainText('You can leave this page and come back');
  await expect(page.getByRole('main').getByTestId('change-approver')).toContainText('by you');
  await expect(page.getByRole('button', { name: /Approve|Decline/ })).toHaveCount(0);
  await shot(page, testInfo, 'salesforce-admin-07-running');

  // A request in words: what was asked, and nothing to approve — only to build or decline.
  await page.goto(`/salesforce-admin/changes/${fixture.request}`);
  await expect(page.getByRole('main').getByTestId('change-request-text')).toContainText(
    'Site_Visit__c needs Outcome__c: Completed, No show.'
  );
  await expect(page.getByRole('button', { name: /Approve/ })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Decline it' })).toBeVisible();
  const words = await page.request.post(`/api/salesforce-admin/changes/${fixture.request}/apply`);
  expect(words.status()).toBe(409);

  // The person who asked: their request waits for an operator, nothing to approve.
  await page.context().clearCookies();
  await page.context().addCookies([
    {
      name: 'renkei_session',
      value: fixture.askerSessionId,
      domain: '127.0.0.1',
      path: '/',
      httpOnly: true,
      secure: false,
      sameSite: 'Lax',
    },
  ]);
  await page.goto('/salesforce-admin/changes');
  await expect(page.getByRole('heading', { name: 'Waiting for an operator' })).toBeVisible();
  // Their own two, and none of the operator's.
  await expect(page.getByRole('main').getByTestId('changes-waiting').getByRole('link')).toHaveCount(
    1
  );
  await expect(page.getByRole('main').getByTestId('changes-running').getByRole('link')).toHaveCount(
    1
  );
  await shot(page, testInfo, 'salesforce-admin-08-asker-list');
  await page.getByRole('main').getByTestId('changes-waiting').getByRole('link').click();
  await expect(page.getByRole('main').getByTestId('change-request-text')).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByRole('main').getByTestId('change-requester')).toContainText('by you');
  await expect(page.getByRole('button', { name: /Approve|Decline/ })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Withdraw it' })).toBeVisible();
  await expect(
    page.getByText(/An operator reviews and approves changes to UAT/)
  ).toBeVisible();
  await shot(page, testInfo, 'salesforce-admin-09-asker-review');
  // The route holds the line, whatever the page shows.
  const notAllowed = await page.request.post(
    `/api/salesforce-admin/changes/${fixture.running}/apply`
  );
  expect(notAllowed.status()).toBe(403);
  await page.setViewportSize(MOBILE_VIEWPORT);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth
    )
  ).toBeLessThanOrEqual(0);
  await shot(page, testInfo, 'salesforce-admin-10-asker-review-mobile');
  await page.setViewportSize({ width: 1280, height: 900 });

  // They withdraw it.
  await page.getByRole('button', { name: 'Withdraw it' }).click();
  await expect(page.getByRole('main').getByTestId('change-state')).toHaveText('Cancelled', {
    timeout: 30_000,
  });
});
