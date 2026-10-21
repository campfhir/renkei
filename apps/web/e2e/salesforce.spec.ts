/**
 * Salesforce, end to end in a browser: an operator registers the org's
 * External Client App through the real admin form and save route (a
 * login.salesforce.com address is refused — it must be the org's own My
 * Domain), a person finds the Salesforce card on the connectors page,
 * narrows Renkei's capabilities in the live picker, and the authorize route
 * turns that into a PKCE consent redirect to the org's own My Domain — with
 * the fixed Salesforce scopes, and the narrowing recorded on the pending row
 * rather than sent. Then a simulated completed connect (the row the OAuth
 * callback would write) shows who is connected to which org, and the real
 * disconnect route takes it away.
 *
 * Nothing here reaches Salesforce: the authorize route is read with
 * redirects off (the Location header is the assertion), and the connect is
 * the callback's database row rather than a round trip to the org.
 *
 * Own person, and only its own connector_configs row: connector configs are
 * organization-wide and shared by every spec in a run, so this one writes
 * and clears `salesforce` alone (AGENTS.md, "Isolate what you create").
 *
 * Runs on the pinned Chromium only; "mobile" is a resized viewport, per AGENTS.md.
 */

import { createHash } from 'node:crypto';
import path from 'node:path';
import { test, expect, type Page, type TestInfo } from '@playwright/test';
import { Client } from 'pg';
import { enrollForE2E } from './keys';

const RESULTS = path.join(import.meta.dirname, '..', 'test-results');
const MOBILE_VIEWPORT = { width: 390, height: 844 };
const MY_DOMAIN = 'acme-e2e.my.salesforce.com';

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
    await client.query(`INSERT INTO identities (subject, email, display_name) VALUES ($1, $2, $3)`, [
      fixture.subject,
      fixture.subject,
      'E2E Tester',
    ]);
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

/** The row the OAuth callback writes once Salesforce sends the person back. */
async function connectSalesforce(fixture: Fixture): Promise<void> {
  await withDb((client) =>
    client.query(
      `INSERT INTO provider_grants
         (provider, provider_account_id, subject, client_id, display_name,
          encrypted_access_token, encrypted_refresh_token, expires_at, requested_scopes, metadata)
       VALUES ('salesforce', $1, $2, 'e2e-sf-client', 'Ada Admin',
               'not-a-real-token', 'not-a-real-token', $3, $4, $5)`,
      [
        `00D000000000062EAA/005000000000001AAA-${fixture.subject}`,
        fixture.subject,
        new Date(Date.now() + 3_600_000),
        ['sf-records-read', 'sf-reports'],
        {
          orgId: '00D000000000062EAA',
          userId: '005000000000001AAA',
          instanceUrl: `https://${MY_DOMAIN}`,
          username: 'ada@acme.org',
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

test('salesforce: register the org app, connect with narrowed capabilities, disconnect', async ({
  page,
}, testInfo) => {
  const fixture = fixtureFor(testInfo.project.name);
  await seedPerson(fixture);
  await signIn(page, fixture);

  // --- The operator registers the org's External Client App. ---
  await page.goto('/admin/connectors/salesforce');
  await expect(page.getByRole('heading', { name: 'Salesforce', level: 1 })).toBeVisible();
  const form = page.locator('[data-coach="admin-connector-form"]');
  await expect(form.getByText('External Client App')).toBeVisible();
  // Deleting and reassigning start off; nobody can grant what the org holds back.
  await expect(form.getByRole('checkbox', { name: /Delete records/ })).not.toBeChecked();
  await expect(form.getByRole('checkbox', { name: /Change record owners/ })).not.toBeChecked();

  // The generic login host is refused: it must be the org's own My Domain.
  await form.getByLabel('My Domain').fill('login.salesforce.com');
  await form.getByLabel('Consumer key').fill('e2e-sf-client');
  await form.getByLabel('Consumer secret').fill('e2e-sf-secret');
  await form.getByRole('button', { name: 'Save' }).click();
  // The route's refusal, not the field's hint (which also names login.salesforce.com).
  await expect(form.getByText(/must be the org’s own My Domain/)).toBeVisible({ timeout: 30_000 });
  const refusedSave = await withDb((client) =>
    client.query(`SELECT 1 FROM connector_configs WHERE connector = 'salesforce'`)
  );
  expect(refusedSave.rowCount).toBe(0);

  await form.getByLabel('My Domain').fill(`https://${MY_DOMAIN}/lightning/page/home`);
  await form.getByRole('button', { name: 'Save' }).click();
  await expect(form.getByText('Saved')).toBeVisible({ timeout: 30_000 });
  await shot(page, testInfo, 'salesforce-01-registered');

  await page.reload();
  await expect(form.getByLabel('Consumer secret')).toHaveAttribute(
    'placeholder',
    'Stored — leave blank to keep'
  );
  // Stored normalized to the org's origin, with the default ceiling.
  await expect(form.getByLabel('My Domain')).toHaveValue(`https://${MY_DOMAIN}`);
  const stored = await withDb((client) =>
    client.query<{ enabled: boolean; settings: { myDomain?: string; scopes?: string } }>(
      `SELECT enabled, settings FROM connector_configs WHERE connector = 'salesforce'`
    )
  );
  expect(stored.rows[0]?.enabled).toBe(true);
  expect(stored.rows[0]?.settings.myDomain).toBe(`https://${MY_DOMAIN}`);
  expect(stored.rows[0]?.settings.scopes?.split(' ').sort()).toEqual(
    ['sf-records-read', 'sf-records-write', 'sf-reports'].sort()
  );

  // --- The person connects from the Salesforce card. ---
  await page.goto('/connectors');
  const card = page.locator('[data-coach="card-salesforce"]');
  await expect(card.getByRole('heading', { name: 'Salesforce' })).toBeVisible();
  await expect(card.getByText('Not connected')).toBeVisible();
  await expect(card.getByText(MY_DOMAIN)).toBeVisible();

  await card.getByText(/What Renkei may do/).click();
  // What the org held back is not offered.
  await expect(card.getByRole('checkbox', { name: /Delete records/ })).toHaveCount(0);
  const connect = card.getByRole('link', { name: 'Connect Salesforce' });
  await expect(connect).toHaveAttribute('href', /sf-records-write/);
  await card.getByRole('checkbox', { name: /Create and update records/ }).uncheck();
  await expect(connect).not.toHaveAttribute('href', /sf-records-write/);
  await shot(page, testInfo, 'salesforce-02-narrowed');

  // The authorize route sends the person to the org's own My Domain, with
  // PKCE and Salesforce's fixed scopes; the narrowing stays with Renkei.
  const href = await connect.getAttribute('href');
  expect(href).toMatch(/^\/api\/salesforce\/authorize/);
  const authorize = await page.request.get(href ?? '', { maxRedirects: 0 });
  expect([302, 307]).toContain(authorize.status());
  const consent = new URL(authorize.headers()['location'] ?? '');
  expect(consent.origin + consent.pathname).toBe(`https://${MY_DOMAIN}/services/oauth2/authorize`);
  expect(consent.searchParams.get('client_id')).toBe('e2e-sf-client');
  expect(consent.searchParams.get('scope')).toBe('api refresh_token id');
  expect(consent.searchParams.get('code_challenge_method')).toBe('S256');
  expect(consent.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);
  const pending = await withDb((client) =>
    client.query<{ scopes: string; code_verifier: string | null }>(
      `SELECT scopes, code_verifier FROM pending_oidc_signin WHERE state = $1`,
      [consent.searchParams.get('state')]
    )
  );
  expect(pending.rows[0]?.scopes.split(' ').sort()).toEqual(['sf-records-read', 'sf-reports']);
  expect(pending.rows[0]?.code_verifier).toBeTruthy();

  // A capability beyond the org's ceiling is refused, not silently dropped.
  const widened = await page.request.get(
    '/api/salesforce/authorize?scopes=sf-records-read+sf-records-delete',
    { maxRedirects: 0 }
  );
  expect(widened.status()).toBe(400);

  // --- Connected: the callback's row, then the real disconnect route. ---
  await connectSalesforce(fixture);
  await page.reload();
  await expect(card).toHaveCount(1);
  await expect(card.getByText('Connected', { exact: true })).toBeVisible();
  await expect(card.getByText('Ada Admin')).toBeVisible();
  await expect(card.getByText('(ada@acme.org)')).toBeVisible();
  await shot(page, testInfo, 'salesforce-03-connected');

  await card.getByRole('button', { name: 'Disconnect Salesforce' }).click();
  await expect(card.getByText(/revoked in Salesforce too/)).toBeVisible();
  await card.getByRole('button', { name: 'Yes, disconnect' }).click();
  await expect(card.getByText('Not connected')).toBeVisible({ timeout: 30_000 });
  const remaining = await withDb((client) =>
    client.query(`SELECT 1 FROM provider_grants WHERE subject = $1`, [fixture.subject])
  );
  expect(remaining.rowCount).toBe(0);

  // Mobile: a resized Chromium viewport, not a device descriptor.
  await page.setViewportSize(MOBILE_VIEWPORT);
  await expect(card.getByRole('heading', { name: 'Salesforce' })).toBeVisible();
  await expect(card.getByRole('link', { name: 'Connect Salesforce' })).toBeVisible();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth
  );
  expect(overflow).toBeLessThanOrEqual(0);
  await shot(page, testInfo, 'salesforce-04-mobile');
});
