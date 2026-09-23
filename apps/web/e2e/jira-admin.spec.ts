/**
 * Jira Administration, end to end in a browser: an operator registers the
 * fifth Atlassian app through the real admin form and save route, a person
 * finds its panel inside the Atlassian card, narrows its classic scopes in
 * the live picker, and the authorize route turns that into a consent
 * redirect carrying exactly those scopes. Then a simulated completed
 * connect (the row the OAuth callback would write) shows the connected
 * state, and the real disconnect route takes it away again — without
 * touching the person's everyday Jira, which is connected alongside it the
 * whole time (and whose connected panel once took the whole page down: a
 * server-rendered card handing a function to a client component).
 *
 * Nothing here reaches Atlassian: the authorize route is read with
 * redirects off (the Location header is the assertion), and the connect is
 * the callback's database row rather than a round trip to
 * auth.atlassian.com.
 *
 * Own tenant, same reasoning as connectors.spec.ts and llm-models.spec.ts:
 * this spec writes a connector config and a grant through real routes, and
 * projects run concurrently against the same dev Postgres.
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
    tenantId: uuidFrom(`jira-admin-e2e-tenant:${projectName}`),
    sessionId: uuidFrom(`jira-admin-e2e-session:${projectName}`),
    slug: `e2e-jira-admin-${projectName}`,
    subject: `e2e-jira-admin-${projectName}@example.com`,
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
    // Everyday Jira is set up and connected — the usual state for someone
    // who then adds Jira Administration, which is not configured yet.
    await client.query(
      `INSERT INTO connector_configs (tenant_id, connector, enabled, encrypted_secrets, settings)
       VALUES ($1, 'atlassian', true, 'not-a-real-secret', '{}'::jsonb)`,
      [fixture.tenantId]
    );
    await client.query(
      `INSERT INTO provider_grants
         (tenant_id, provider, provider_account_id, subject, client_id, display_name,
          encrypted_access_token, encrypted_refresh_token, expires_at, requested_scopes,
          metadata)
       VALUES ($1, 'atlassian', 'e2e-jira-account', $2, 'e2e-jira-client', 'E2E Jira User',
               'not-a-real-token', 'not-a-real-token', $3, $4, $5)`,
      [
        fixture.tenantId,
        fixture.subject,
        new Date(Date.now() + 365 * 24 * 3_600_000),
        ['read:issue:jira', 'offline_access'],
        { cloudId: 'e2e-cloud', siteUrl: 'https://e2e.atlassian.net' },
      ]
    );
    await client.query(
      `INSERT INTO user_preferences (tenant_id, subject, key, value)
       VALUES ($1, $2, 'connectors', '{"added": ["jira", "jira-admin"]}'::jsonb)`,
      [fixture.tenantId, fixture.subject]
    );
  });
}

/** The row the OAuth callback writes once Atlassian sends the person back. */
async function connectJiraAdmin(fixture: Fixture): Promise<void> {
  await withDb((client) =>
    client.query(
      `INSERT INTO provider_grants
         (tenant_id, provider, provider_account_id, subject, client_id, display_name,
          encrypted_access_token, encrypted_refresh_token, expires_at, requested_scopes,
          metadata)
       VALUES ($1, 'atlassian-admin', 'e2e-jira-admin-account', $2, 'e2e-admin-client',
               'E2E Jira Admin', 'not-a-real-token', 'not-a-real-token', $3, $4, $5)`,
      [
        fixture.tenantId,
        fixture.subject,
        new Date(Date.now() + 365 * 24 * 3_600_000),
        ['read:jira-user', 'read:jira-work', 'manage:jira-configuration', 'offline_access'],
        { cloudId: 'e2e-cloud', siteUrl: 'https://e2e.atlassian.net' },
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

test('jira administration: register the app, connect with narrowed classic scopes, disconnect', async ({
  page,
}, testInfo) => {
  const fixture = fixtureFor(testInfo.project.name);
  await seedTenant(fixture);
  await signIn(page, fixture);

  // --- The operator registers the fifth Atlassian app. ---
  await page.goto(`/${fixture.slug}/admin/connectors/atlassian-admin`);
  await expect(page.getByRole('heading', { name: 'Jira Administration', level: 1 })).toBeVisible();
  const form = page.locator('[data-coach="admin-connector-form"]');
  await expect(form.getByText('Atlassian (Jira Administration)')).toBeVisible();
  // The classic-scope setup note is the one thing an operator must not miss.
  await expect(form.getByText(/Classic scopes/)).toBeVisible();
  await expect(form.getByText('Read access & space details')).toBeVisible();
  await expect(form.getByText('Site configuration')).toBeVisible();

  await form.getByLabel('Client ID').fill('e2e-admin-client');
  await form.getByLabel('Client secret').fill('e2e-admin-secret');
  await form.getByRole('button', { name: 'Save' }).click();
  await expect(form.getByText('Saved')).toBeVisible({ timeout: 30_000 });
  await shot(page, testInfo, 'jira-admin-01-registered');

  // Saved for real: a reload shows the stored secret as stored, never its value.
  await page.reload();
  await expect(form.getByLabel('Client secret')).toHaveAttribute(
    'placeholder',
    'Stored — leave blank to keep'
  );
  const stored = await withDb((client) =>
    client.query<{ enabled: boolean; settings: { scopes?: string } }>(
      `SELECT enabled, settings FROM connector_configs WHERE tenant_id = $1 AND connector = $2`,
      [fixture.tenantId, 'atlassian-admin']
    )
  );
  expect(stored.rows[0]?.enabled).toBe(true);
  expect(stored.rows[0]?.settings.scopes?.split(' ').sort()).toEqual(
    ['manage:jira-configuration', 'offline_access', 'read:jira-user', 'read:jira-work'].sort()
  );

  // --- The person connects it from the Atlassian card. ---
  await page.goto(`/${fixture.slug}/connectors`);
  const jiraPanel = page.locator('[data-coach="card-jira"]');
  await expect(jiraPanel.getByText('Connected', { exact: true })).toBeVisible();
  await expect(jiraPanel.getByRole('button', { name: 'Disconnect Jira' })).toBeVisible();
  const panel = page.locator('[data-coach="card-jira-admin"]');
  await expect(panel.getByRole('heading', { name: 'Jira Administration' })).toBeVisible();
  await expect(panel.getByText('Not connected')).toBeVisible();

  // The live picker narrows the classic scopes before any round trip:
  // leaving out site configuration drops manage:jira-configuration from
  // the authorize link.
  await panel.getByText(/What Renkei may do/).click();
  const connect = panel.getByRole('link', { name: 'Connect Jira Administration' });
  await expect(connect).toHaveAttribute('href', /manage%3Ajira-configuration/);
  await panel.getByRole('checkbox', { name: /Site configuration/ }).uncheck();
  await expect(connect).not.toHaveAttribute('href', /manage%3Ajira-configuration/);
  await shot(page, testInfo, 'jira-admin-02-narrowed');

  // The authorize route turns the narrowed choice into Atlassian's consent
  // redirect — read with redirects off, so nothing leaves this machine.
  const href = await connect.getAttribute('href');
  expect(href).toMatch(new RegExp(`^/api/atlassian-admin/${fixture.tenantId}/authorize`));
  const authorize = await page.request.get(href ?? '', { maxRedirects: 0 });
  expect([302, 307]).toContain(authorize.status());
  const consent = new URL(authorize.headers()['location'] ?? '');
  expect(consent.origin + consent.pathname).toBe('https://auth.atlassian.com/authorize');
  expect(consent.searchParams.get('client_id')).toBe('e2e-admin-client');
  expect(consent.searchParams.get('scope')?.split(' ').sort()).toEqual(
    ['offline_access', 'read:jira-user', 'read:jira-work'].sort()
  );

  // A scope beyond the org's ceiling is refused, not silently dropped.
  const widened = await page.request.get(
    `/api/atlassian-admin/${fixture.tenantId}/authorize?scopes=read:jira-work+manage:jira-project`,
    { maxRedirects: 0 }
  );
  expect(widened.status()).toBe(400);

  // --- Connected: the callback's row, then the real disconnect route. ---
  await connectJiraAdmin(fixture);
  await page.reload();
  await expect(panel.getByText('Connected as')).toBeVisible();
  await expect(panel.getByText('E2E Jira Admin')).toBeVisible();
  await shot(page, testInfo, 'jira-admin-03-connected');

  await panel.getByRole('button', { name: 'Disconnect Jira Administration' }).click();
  await expect(panel.getByText(/Your Jira connection is not affected/)).toBeVisible();
  await panel.getByRole('button', { name: 'Yes, disconnect' }).click();
  await expect(panel.getByText('Not connected')).toBeVisible({ timeout: 30_000 });
  const remaining = await withDb((client) =>
    client.query(
      `SELECT 1 FROM provider_grants WHERE tenant_id = $1 AND provider = 'atlassian-admin'`,
      [fixture.tenantId]
    )
  );
  expect(remaining.rowCount).toBe(0);
  // Separate apps, separate grants: everyday Jira is still connected.
  await expect(jiraPanel.getByText('Connected', { exact: true })).toBeVisible();

  // Mobile: a resized Chromium viewport, not a device descriptor.
  await page.setViewportSize(MOBILE_VIEWPORT);
  await expect(panel.getByRole('heading', { name: 'Jira Administration' })).toBeVisible();
  await expect(panel.getByRole('link', { name: 'Connect Jira Administration' })).toBeVisible();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth
  );
  expect(overflow).toBeLessThanOrEqual(0);
  await shot(page, testInfo, 'jira-admin-04-mobile');
});
