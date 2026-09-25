/**
 * Entra Developer, end to end in a browser: an operator registers the
 * second Entra app through the real admin form and save route, a person
 * finds its own card on the connectors page (beside a connected Microsoft
 * 365, which it must not touch), narrows its directory-wide scopes in the
 * live picker, and the authorize route turns that into a Microsoft consent
 * redirect carrying exactly those scopes. Then a simulated completed
 * connect (the row the OAuth callback would write) shows the connected
 * state, and the real disconnect route takes it away again — leaving the
 * Microsoft 365 grant connected the whole time.
 *
 * Nothing here reaches Microsoft: the authorize route is read with
 * redirects off (the Location header is the assertion), and the connect is
 * the callback's database row rather than a round trip to
 * login.microsoftonline.com.
 *
 * Own tenant, same reasoning as jira-admin.spec.ts: this spec writes a
 * connector config and grants through real routes, and projects run
 * concurrently against the same dev Postgres.
 *
 * Runs on the pinned Chromium only (no WebKit installed in this sandbox —
 * see voice.spec.ts's note); "mobile" is a resized viewport, per AGENTS.md.
 */

import { createHash } from 'node:crypto';
import path from 'node:path';
import { test, expect, type Page, type TestInfo } from '@playwright/test';
import { Client } from 'pg';

const RESULTS = path.join(import.meta.dirname, '..', 'test-results');
const MOBILE_VIEWPORT = { width: 390, height: 844 };

test.use({
  launchOptions: {
    executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    args: ['--no-sandbox'],
  },
});

/** A deterministic (stable across reruns), valid-looking v4 UUID from a seed string. */
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

/** This project's own tenant/session/slug — isolated from every other project and spec. */
function fixtureFor(projectName: string): {
  tenantId: string;
  sessionId: string;
  slug: string;
  subject: string;
} {
  return {
    tenantId: uuidFrom(`entra-developer-e2e-tenant:${projectName}`),
    sessionId: uuidFrom(`entra-developer-e2e-session:${projectName}`),
    slug: `e2e-entra-dev-${projectName}`,
    subject: `e2e-entra-dev-${projectName}@example.com`,
  };
}

type Fixture = ReturnType<typeof fixtureFor>;

const DIRECTORY_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

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
    await client.query('DELETE FROM provider_grants WHERE tenant_id = $1', [fixture.tenantId]);
    await client.query('DELETE FROM connector_configs WHERE tenant_id = $1', [fixture.tenantId]);
    await client.query('DELETE FROM pending_oidc_signin WHERE tenant_id = $1', [fixture.tenantId]);
    await client.query('DELETE FROM user_preferences WHERE tenant_id = $1', [fixture.tenantId]);
    await client.query('DELETE FROM sessions WHERE tenant_id = $1', [fixture.tenantId]);
    await client.query('DELETE FROM identities WHERE tenant_id = $1', [fixture.tenantId]);
    await client.query('DELETE FROM tenants WHERE id = $1', [fixture.tenantId]);
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
        ['renkei-user', 'renkei-operator'],
        new Date(Date.now() + 24 * 3_600_000),
      ]
    );
    await client.query(
      `INSERT INTO identities (tenant_id, subject, email, display_name)
       VALUES ($1, $2, $3, $4)`,
      [fixture.tenantId, fixture.subject, fixture.subject, 'E2E Tester']
    );
    // No coach marks tour stealing focus mid-screenshot.
    await client.query(
      `INSERT INTO user_preferences (tenant_id, subject, key, value)
       VALUES ($1, $2, 'coach_marks', '{"autoStart": false}'::jsonb)`,
      [fixture.tenantId, fixture.subject]
    );
    // Microsoft 365 is set up and connected — the usual state for someone
    // who then adds Entra Developer, which is not configured yet.
    await client.query(
      `INSERT INTO connector_configs (tenant_id, connector, enabled, encrypted_secrets, settings)
       VALUES ($1, 'microsoft', true, 'not-a-real-secret', $2::jsonb)`,
      [fixture.tenantId, JSON.stringify({ clientId: 'e2e-m365', directoryTenantId: DIRECTORY_ID })]
    );
    await client.query(
      `INSERT INTO provider_grants
         (tenant_id, provider, provider_account_id, subject, client_id, display_name,
          encrypted_access_token, encrypted_refresh_token, expires_at, requested_scopes,
          metadata)
       VALUES ($1, 'microsoft', 'e2e-m365-account', $2, 'e2e-m365', 'E2E M365 User',
               'not-a-real-token', 'not-a-real-token', $3, $4, $5)`,
      [
        fixture.tenantId,
        fixture.subject,
        new Date(Date.now() + 365 * 24 * 3_600_000),
        ['Mail.Read', 'offline_access'],
        { tid: DIRECTORY_ID, upn: 'e2e@example.com' },
      ]
    );
    await client.query(
      `INSERT INTO user_preferences (tenant_id, subject, key, value)
       VALUES ($1, $2, 'connectors', '{"added": ["microsoft", "entra-developer"]}'::jsonb)`,
      [fixture.tenantId, fixture.subject]
    );
  });
}

/** The row the OAuth callback writes once Microsoft sends the person back. */
async function connectEntraDeveloper(fixture: Fixture): Promise<void> {
  await withDb((client) =>
    client.query(
      `INSERT INTO provider_grants
         (tenant_id, provider, provider_account_id, subject, client_id, display_name,
          encrypted_access_token, encrypted_refresh_token, expires_at, requested_scopes,
          metadata)
       VALUES ($1, 'entra-developer', 'e2e-entra-account', $2, 'e2e-entra-client',
               'E2E Entra Developer', 'not-a-real-token', 'not-a-real-token', $3, $4, $5)`,
      [
        fixture.tenantId,
        fixture.subject,
        new Date(Date.now() + 365 * 24 * 3_600_000),
        ['Application.Read.All', 'Application.ReadWrite.All', 'offline_access'],
        { tid: DIRECTORY_ID, upn: 'e2e@example.com' },
      ]
    )
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

test('entra developer: register the app, connect with narrowed scopes, disconnect', async ({
  page,
}, testInfo) => {
  const fixture = fixtureFor(testInfo.project.name);
  await seedTenant(fixture);
  await signIn(page, fixture);

  // --- The operator registers the second Entra app. ---
  await page.goto(`/${fixture.slug}/admin/connectors/entra-developer`);
  await expect(page.getByRole('heading', { name: 'Entra Developer', level: 1 })).toBeVisible();
  const form = page.locator('[data-coach="admin-connector-form"]');
  // The one thing an operator must not miss: it is a separate app, and
  // its permissions need an admin's consent.
  await expect(form.getByText(/separate/)).toBeVisible();
  await expect(form.getByText('Read applications')).toBeVisible();
  await expect(form.getByText('Assign people and groups to app roles')).toBeVisible();
  // Every box starts ticked; this org holds group lookups back, so its
  // people cannot pick them (below) until an admin ticks it here.
  const groups = form.getByRole('checkbox', { name: /Find groups/ });
  await expect(groups).toBeChecked();
  await groups.uncheck();

  await form.getByLabel('Client ID').fill('e2e-entra-client');
  await form.getByLabel('Directory (tenant) ID').fill(DIRECTORY_ID);
  await form.getByLabel('Client secret').fill('e2e-entra-secret');
  await form.getByRole('button', { name: 'Save' }).click();
  await expect(form.getByText('Saved')).toBeVisible({ timeout: 30_000 });
  await shot(page, testInfo, 'entra-developer-01-registered');

  // Saved for real: a reload shows the stored secret as stored, never its value.
  await page.reload();
  await expect(form.getByLabel('Client secret')).toHaveAttribute(
    'placeholder',
    'Stored — leave blank to keep'
  );
  const stored = await withDb((client) =>
    client.query<{ enabled: boolean; settings: { scopes?: string; directoryTenantId?: string } }>(
      `SELECT enabled, settings FROM connector_configs WHERE tenant_id = $1 AND connector = $2`,
      [fixture.tenantId, 'entra-developer']
    )
  );
  expect(stored.rows[0]?.enabled).toBe(true);
  expect(stored.rows[0]?.settings.directoryTenantId).toBe(DIRECTORY_ID);
  expect(stored.rows[0]?.settings.scopes?.split(' ').sort()).toEqual(
    [
      'Application.Read.All',
      'Application.ReadWrite.All',
      'AppRoleAssignment.ReadWrite.All',
      'User.ReadBasic.All',
      'openid',
      'profile',
      'email',
      'offline_access',
      'User.Read',
    ].sort()
  );

  // --- The person connects it from its own card. ---
  await page.goto(`/${fixture.slug}/connectors`);
  const microsoftCard = page.locator('[data-coach="card-microsoft"]');
  await expect(microsoftCard.getByText('Connected', { exact: true })).toBeVisible();
  const card = page.locator('[data-coach="card-entra-developer"]');
  await expect(card.getByRole('heading', { name: 'Entra Developer' })).toBeVisible();
  await expect(card.getByText('Not connected')).toBeVisible();

  // The live picker narrows the scopes before any round trip: leaving out
  // the write bundle drops Application.ReadWrite.All from the authorize link.
  await card.getByText(/What Renkei may do/).click();
  // What the org held back is not even offered.
  await expect(card.getByRole('checkbox', { name: /Find groups/ })).toHaveCount(0);
  const connect = card.getByRole('link', { name: 'Connect Entra Developer' });
  await expect(connect).toHaveAttribute('href', /Application\.ReadWrite\.All/);
  await card.getByRole('checkbox', { name: /Create and change applications/ }).uncheck();
  await expect(connect).not.toHaveAttribute('href', /Application\.ReadWrite\.All/);
  await shot(page, testInfo, 'entra-developer-02-narrowed');

  // The authorize route turns the narrowed choice into Microsoft's consent
  // redirect — read with redirects off, so nothing leaves this machine —
  // against the org's own directory, never `common`.
  const href = await connect.getAttribute('href');
  expect(href).toMatch(new RegExp(`^/api/entra-developer/${fixture.tenantId}/authorize`));
  const authorize = await page.request.get(href ?? '', { maxRedirects: 0 });
  expect([302, 307]).toContain(authorize.status());
  const consent = new URL(authorize.headers()['location'] ?? '');
  expect(consent.origin + consent.pathname).toBe(
    `https://login.microsoftonline.com/${DIRECTORY_ID}/oauth2/v2.0/authorize`
  );
  expect(consent.searchParams.get('client_id')).toBe('e2e-entra-client');
  expect(consent.searchParams.get('scope')?.split(' ').sort()).toEqual(
    [
      'Application.Read.All',
      'AppRoleAssignment.ReadWrite.All',
      'User.ReadBasic.All',
      'openid',
      'profile',
      'email',
      'offline_access',
      'User.Read',
    ].sort()
  );

  // A scope beyond the org's ceiling — the box it held back — is refused,
  // not silently dropped.
  const widened = await page.request.get(
    `/api/entra-developer/${fixture.tenantId}/authorize?scopes=Application.Read.All+Group.Read.All`,
    { maxRedirects: 0 }
  );
  expect(widened.status()).toBe(400);

  // --- Connected: the callback's row, then the real disconnect route. ---
  await connectEntraDeveloper(fixture);
  await page.reload();
  // The card moves out of "Needs setup" on this reload; wait for the new
  // document to have settled to one card before reading inside it (the dev
  // server's first compile once left the old one briefly beside the new).
  await expect(card).toHaveCount(1);
  await expect(card.getByText('Connected', { exact: true })).toBeVisible();
  await expect(card.getByText('Connected as')).toBeVisible();
  await expect(card.getByText('E2E Entra Developer')).toBeVisible();
  await shot(page, testInfo, 'entra-developer-03-connected');

  await card.getByRole('button', { name: 'Disconnect Entra Developer' }).click();
  await expect(card.getByText(/Your Microsoft 365 connection is not affected/)).toBeVisible();
  await card.getByRole('button', { name: 'Yes, disconnect' }).click();
  await expect(card.getByText('Not connected')).toBeVisible({ timeout: 30_000 });
  const remaining = await withDb((client) =>
    client.query(`SELECT provider FROM provider_grants WHERE tenant_id = $1 ORDER BY provider`, [
      fixture.tenantId,
    ])
  );
  // Separate apps, separate grants: Microsoft 365 is still connected.
  expect(remaining.rows.map((row) => row.provider)).toEqual(['microsoft']);
  await expect(microsoftCard.getByText('Connected', { exact: true })).toBeVisible();

  // Mobile: a resized Chromium viewport, not a device descriptor.
  await page.setViewportSize(MOBILE_VIEWPORT);
  await expect(card.getByRole('heading', { name: 'Entra Developer' })).toBeVisible();
  await expect(card.getByRole('link', { name: 'Connect Entra Developer' })).toBeVisible();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth
  );
  expect(overflow).toBeLessThanOrEqual(0);
  await shot(page, testInfo, 'entra-developer-04-mobile');
});
