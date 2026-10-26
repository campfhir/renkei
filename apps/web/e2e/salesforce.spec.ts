/**
 * Salesforce, end to end in a browser, with one connector per org: an
 * operator adds the production org and a UAT sandbox through the real admin
 * list and save route (a login.salesforce.com address is refused — each must
 * be the org's own My Domain), a person finds one card per org on the
 * connectors page, narrows Renkei's capabilities on the sandbox's card, and
 * that connector's authorize route turns it into a PKCE consent redirect to
 * the sandbox's own My Domain with the sandbox's own consumer key — the
 * fixed Salesforce scopes sent, the narrowing and the connector recorded on
 * the pending row. Then a simulated completed connect (the row the OAuth
 * callback would write) shows the sandbox connected and production not, and
 * the real disconnect route takes the sandbox connection away. Finally the
 * operator removes the sandbox connector and its card goes.
 *
 * Nothing here reaches Salesforce: the authorize route is read with
 * redirects off (the Location header is the assertion), and the connect is
 * the callback's database row rather than a round trip to the org.
 *
 * Own person, and only its own connector_configs row: connector configs are
 * organization-wide and shared by every spec in a run, so this one writes
 * and clears `salesforce` alone (AGENTS.md, "Isolate what you create") —
 * run its projects one at a time (--workers=1) for that reason.
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
const PRODUCTION = 'acme-e2e.my.salesforce.com';
const UAT = 'acme-e2e--uat.sandbox.my.salesforce.com';

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
    sessionId: uuidFrom(`salesforce-e2e-session:${projectName}`),
    subject: `e2e-salesforce-${projectName}@example.com`,
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

async function seedPerson(fixture: Fixture): Promise<void> {
  await withDb(async (client) => {
    await client.query('DELETE FROM provider_grants WHERE subject = $1', [fixture.subject]);
    await client.query(`DELETE FROM connector_configs WHERE connector = 'salesforce'`);
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
      `INSERT INTO user_preferences (subject, key, value) VALUES ($1, 'connectors', '{"added": ["salesforce"]}'::jsonb)`,
      [fixture.subject]
    );
    // Enrolled already (docs/delegate-key-design.md), so the first-sign-in
    // "your encryption key is ready" dialog does not sit over the forms.
    await enrollForE2E(client, fixture.subject);
  });
}

/** The row the OAuth callback writes once the UAT sandbox sends the person back. */
async function connectUat(fixture: Fixture): Promise<void> {
  await withDb((client) =>
    client.query(
      `INSERT INTO provider_grants
         (provider, provider_account_id, subject, client_id, display_name,
          encrypted_access_token, encrypted_refresh_token, expires_at, requested_scopes, metadata)
       VALUES ('salesforce', $1, $2, 'e2e-uat-client', 'Ada Admin',
               'not-a-real-token', 'not-a-real-token', $3, $4, $5)`,
      [
        `00D000000000062EAA/005000000000001AAA-${fixture.subject}`,
        fixture.subject,
        new Date(Date.now() + 3_600_000),
        ['sf-records-read', 'sf-reports'],
        {
          orgId: '00D000000000062EAA',
          userId: '005000000000001AAA',
          instanceUrl: `https://${UAT}`,
          username: 'ada@acme.org',
          connector: 'uat',
        },
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

// eslint-disable-next-line no-empty-pattern -- Playwright needs the fixtures object first
test.afterEach(async ({}, testInfo) => {
  const fixture = fixtureFor(testInfo.project.name);
  await withDb(async (client) => {
    await client.query('DELETE FROM provider_grants WHERE subject = $1', [fixture.subject]);
    await client.query(`DELETE FROM connector_configs WHERE connector = 'salesforce'`);
  });
});

async function addOrg(
  page: Page,
  values: { name?: string; domain: string; clientId: string; secret: string }
): Promise<void> {
  const form = page.locator('[data-coach="admin-connector-form"]');
  if (values.name !== undefined) await form.locator('#salesforce-new-name').fill(values.name);
  await form.locator('#salesforce-new-domain').fill(values.domain);
  await form.locator('#salesforce-new-client-id').fill(values.clientId);
  await form.locator('#salesforce-new-client-secret').fill(values.secret);
  await form.getByRole('button', { name: 'Save' }).click();
}

test('salesforce: one connector per org — register, connect a sandbox, disconnect, remove', async ({
  page,
}, testInfo) => {
  // Room for the config cache's TTL at the end (see the last step).
  test.setTimeout(180_000);
  const fixture = fixtureFor(testInfo.project.name);
  await seedPerson(fixture);
  await signIn(page, fixture);

  // --- The operator adds the production org. ---
  await page.goto('/admin/connectors/salesforce');
  await expect(page.getByRole('heading', { name: 'Salesforce', level: 1 })).toBeVisible();
  const form = page.locator('[data-coach="admin-connector-form"]');
  await expect(form.getByText('No Salesforce connectors yet.')).toBeVisible();
  await form.getByRole('button', { name: 'Add your production org' }).click();
  // The first connector is named Production and is not a sandbox.
  await expect(form.locator('#salesforce-new-name')).toHaveValue('Production');
  await expect(form.getByRole('checkbox', { name: 'This is a sandbox' })).not.toBeChecked();
  // Deleting and reassigning start off; nobody can grant what the org holds back.
  await expect(form.getByRole('checkbox', { name: /Delete records/ })).not.toBeChecked();
  await expect(form.getByRole('checkbox', { name: /Change record owners/ })).not.toBeChecked();

  // The generic login host is refused: it must be the org's own My Domain.
  await addOrg(page, {
    domain: 'login.salesforce.com',
    clientId: 'e2e-sf-client',
    secret: 'e2e-sf-secret',
  });
  // The route's refusal, not the field's hint (which also names login.salesforce.com).
  await expect(form.getByText(/My Domain must be the org’s own/)).toBeVisible({ timeout: 30_000 });
  const refusedSave = await withDb((client) =>
    client.query(`SELECT 1 FROM connector_configs WHERE connector = 'salesforce'`)
  );
  expect(refusedSave.rowCount).toBe(0);

  await addOrg(page, {
    domain: `https://${PRODUCTION}/lightning/page/home`,
    clientId: 'e2e-sf-client',
    secret: 'e2e-sf-secret',
  });
  await expect(form.getByRole('heading', { name: 'Salesforce · Production' })).toBeVisible({
    timeout: 30_000,
  });
  // Stored normalized to the org's origin.
  await expect(form.getByText(`https://${PRODUCTION}`, { exact: true })).toBeVisible();

  // --- Then a UAT sandbox: its own connector, its own app. ---
  await form.getByRole('button', { name: 'Add a Salesforce org' }).click();
  await expect(form.getByRole('checkbox', { name: 'This is a sandbox' })).toBeChecked();
  // Two connectors cannot share an org.
  await addOrg(page, {
    name: 'UAT',
    domain: PRODUCTION,
    clientId: 'e2e-uat-client',
    secret: 'e2e-uat-secret',
  });
  await expect(form.getByText(/is already the Production connector/)).toBeVisible({
    timeout: 30_000,
  });
  await addOrg(page, {
    name: 'UAT',
    domain: UAT,
    clientId: 'e2e-uat-client',
    secret: 'e2e-uat-secret',
  });
  await expect(form.getByRole('heading', { name: 'Salesforce · UAT' })).toBeVisible({
    timeout: 30_000,
  });
  await shot(page, testInfo, 'salesforce-01-registered');

  // Editing keeps the stored secret when the field is left blank — and
  // this is where the org keeps objects and fields away from the assistant.
  await form.getByRole('button', { name: 'Edit UAT' }).click();
  await expect(form.locator('#salesforce-uat-client-secret')).toHaveAttribute(
    'placeholder',
    'Stored — leave blank to keep'
  );
  await form.locator('#salesforce-uat-excluded-objects').fill('Case_Note__c');
  // A field without its object is refused by the route.
  await form.locator('#salesforce-uat-excluded-fields').fill('Diagnosis__c');
  await form.getByRole('button', { name: 'Save' }).click();
  await expect(form.getByText(/Hidden fields are Object\.Field API names/)).toBeVisible({
    timeout: 30_000,
  });
  await form.locator('#salesforce-uat-excluded-fields').fill('Contact.Diagnosis__c');
  await form
    .getByRole('checkbox', { name: /Hide every field this org.s data classification/ })
    .check();
  await shot(page, testInfo, 'salesforce-01b-kept-away');
  await form.getByRole('button', { name: 'Save' }).click();
  await expect(
    form.getByText(
      'Case_Note__c (object), Contact.Diagnosis__c, fields classified Restricted or Mission Critical'
    )
  ).toBeVisible({ timeout: 30_000 });

  const stored = await withDb((client) =>
    client.query<{
      enabled: boolean;
      settings: {
        orgs?: {
          key: string;
          myDomain: string;
          sandbox: boolean;
          clientId: string;
          scopes: string;
          excludedObjects?: string[];
          excludedFields?: string[];
          hideRestricted?: boolean;
        }[];
      };
    }>(`SELECT enabled, settings FROM connector_configs WHERE connector = 'salesforce'`)
  );
  expect(stored.rows[0]?.enabled).toBe(true);
  const orgs = stored.rows[0]?.settings.orgs ?? [];
  expect(orgs.map((org) => [org.key, org.myDomain, org.sandbox, org.clientId])).toEqual([
    ['production', `https://${PRODUCTION}`, false, 'e2e-sf-client'],
    ['uat', `https://${UAT}`, true, 'e2e-uat-client'],
  ]);
  expect(orgs[1]?.scopes.split(' ').sort()).toEqual(
    ['sf-records-read', 'sf-records-write', 'sf-reports'].sort()
  );
  expect([orgs[1]?.excludedObjects, orgs[1]?.excludedFields, orgs[1]?.hideRestricted]).toEqual([
    ['Case_Note__c'],
    ['Contact.Diagnosis__c'],
    true,
  ]);
  expect(orgs[0]?.hideRestricted).toBe(false);

  // --- The person sees one card per org, and connects the sandbox. ---
  await page.goto('/connectors');
  const cards = page.locator('[data-coach="card-salesforce"]');
  await expect(cards).toHaveCount(2);
  const production = cards.filter({
    has: page.getByRole('heading', { name: /Salesforce · Production/ }),
  });
  const uat = cards.filter({ has: page.getByRole('heading', { name: /Salesforce · UAT/ }) });
  await expect(production.getByText('Not connected')).toBeVisible();
  await expect(production.getByText(PRODUCTION)).toBeVisible();
  await expect(production.getByText('Sandbox', { exact: true })).toHaveCount(0);
  await expect(uat.getByText('Sandbox', { exact: true })).toBeVisible();
  await expect(uat.getByText(UAT)).toBeVisible();

  await uat.getByText(/What Renkei may do/).click();
  // What the org held back is not offered.
  await expect(uat.getByRole('checkbox', { name: /Delete records/ })).toHaveCount(0);
  const connect = uat.getByRole('link', { name: 'Connect Salesforce · UAT' });
  await expect(connect).toHaveAttribute('href', /sf-records-write/);
  await uat.getByRole('checkbox', { name: /Create and update records/ }).uncheck();
  await expect(connect).not.toHaveAttribute('href', /sf-records-write/);
  await shot(page, testInfo, 'salesforce-02-narrowed');

  // The sandbox's authorize route sends the person to the sandbox's own My
  // Domain with its own consumer key, PKCE and Salesforce's fixed scopes;
  // the narrowing and the connector stay with Renkei.
  const href = await connect.getAttribute('href');
  expect(href).toMatch(/^\/api\/salesforce\/uat\/authorize/);
  const authorize = await page.request.get(href ?? '', { maxRedirects: 0 });
  expect([302, 307]).toContain(authorize.status());
  const consent = new URL(authorize.headers()['location'] ?? '');
  expect(consent.origin + consent.pathname).toBe(`https://${UAT}/services/oauth2/authorize`);
  expect(consent.searchParams.get('client_id')).toBe('e2e-uat-client');
  expect(consent.searchParams.get('scope')).toBe('api refresh_token id');
  expect(consent.searchParams.get('code_challenge_method')).toBe('S256');
  expect(consent.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);
  const pending = await withDb((client) =>
    client.query<{ scopes: string; code_verifier: string | null; connector_key: string | null }>(
      `SELECT scopes, code_verifier, connector_key FROM pending_oidc_signin WHERE state = $1`,
      [consent.searchParams.get('state')]
    )
  );
  expect(pending.rows[0]?.scopes.split(' ').sort()).toEqual(['sf-records-read', 'sf-reports']);
  expect(pending.rows[0]?.code_verifier).toBeTruthy();
  expect(pending.rows[0]?.connector_key).toBe('uat');

  // A capability beyond the connector's ceiling is refused, not silently
  // dropped; so is a connector that does not exist.
  const widened = await page.request.get(
    '/api/salesforce/uat/authorize?scopes=sf-records-read+sf-records-delete',
    { maxRedirects: 0 }
  );
  expect(widened.status()).toBe(400);
  const unknown = await page.request.get('/api/salesforce/full-copy/authorize', {
    maxRedirects: 0,
  });
  expect(unknown.status()).toBe(503);

  // --- Connected to UAT only: the callback's row, then the real disconnect route. ---
  await connectUat(fixture);
  await page.reload();
  await expect(uat.getByText('Connected', { exact: true })).toBeVisible();
  await expect(uat.getByText('Ada Admin')).toBeVisible();
  await expect(uat.getByText('(ada@acme.org)')).toBeVisible();
  await expect(production.getByText('Not connected')).toBeVisible();
  await shot(page, testInfo, 'salesforce-03-connected');

  await uat.getByRole('button', { name: 'Disconnect Salesforce · UAT' }).click();
  await expect(uat.getByText(/Your other Salesforce connections are not affected/)).toBeVisible();
  await uat.getByRole('button', { name: 'Yes, disconnect' }).click();
  await expect(uat.getByText('Not connected')).toBeVisible({ timeout: 30_000 });
  const remaining = await withDb((client) =>
    client.query(`SELECT 1 FROM provider_grants WHERE subject = $1`, [fixture.subject])
  );
  expect(remaining.rowCount).toBe(0);

  // Mobile: a resized Chromium viewport, not a device descriptor.
  await page.setViewportSize(MOBILE_VIEWPORT);
  await expect(uat.getByRole('heading', { name: /Salesforce · UAT/ })).toBeVisible();
  await expect(uat.getByRole('link', { name: 'Connect Salesforce · UAT' })).toBeVisible();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth
  );
  expect(overflow).toBeLessThanOrEqual(0);
  await shot(page, testInfo, 'salesforce-04-mobile');

  // --- The operator removes the sandbox connector; its card goes. ---
  await page.goto('/admin/connectors/salesforce');
  await form.getByRole('button', { name: 'Edit UAT' }).click();
  await form.getByRole('button', { name: 'Remove this connector' }).click();
  await form.getByRole('button', { name: 'Yes, remove' }).click();
  await expect(form.getByRole('heading', { name: 'Salesforce · UAT' })).toHaveCount(0, {
    timeout: 30_000,
  });
  await expect(form.getByRole('heading', { name: 'Salesforce · Production' })).toBeVisible();
  const overflowAdmin = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth
  );
  expect(overflowAdmin).toBeLessThanOrEqual(0);
  await shot(page, testInfo, 'salesforce-05-admin-mobile');
  // The connectors page reads the config through a 60-second cache
  // (@renkei/connector-config), which a save in another module instance
  // does not clear, so the card goes within that TTL rather than at once.
  await expect(async () => {
    await page.goto('/connectors');
    await expect(cards).toHaveCount(1, { timeout: 2_000 });
  }).toPass({ timeout: 90_000, intervals: [5_000] });
  await expect(cards.getByRole('heading', { name: /Salesforce · Production/ })).toBeVisible();
});
