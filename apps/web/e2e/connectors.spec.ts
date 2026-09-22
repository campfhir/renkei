/**
 * The connectors page: the "Needs setup" / "Connected" sectioning that
 * floats added-but-unconnected cards to the top, the live scope picker
 * (now a shared client island, `ScopeConnectPanel`), and the shared
 * disconnect confirm/cancel control (`DisconnectControl`) — exercised
 * against the real save/disconnect routes, not mocked, since neither
 * touches a real vendor for a tenant with no provider app configured
 * (Zoom's disconnect route skips its best-effort revoke call when
 * `getZoomApp` finds nothing to revoke against).
 *
 * Own tenant, same reasoning as llm-models.spec.ts: this spec creates
 * connection state (a grant row, then deletes it) through the real
 * routes, and projects run concurrently against the same dev Postgres —
 * sharing e2e/seed.ts's tenant would race with every other spec reading
 * its connectors page.
 *
 * Runs on the pinned Chromium only (no WebKit installed in this sandbox —
 * see voice.spec.ts's note); "mobile" is a resized viewport rather than
 * the `mobile` project's device descriptor, per AGENTS.md.
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
    tenantId: uuidFrom(`connectors-e2e-tenant:${projectName}`),
    sessionId: uuidFrom(`connectors-e2e-session:${projectName}`),
    slug: `e2e-connectors-${projectName}`,
    subject: `e2e-connectors-${projectName}@example.com`,
  };
}

type Fixture = ReturnType<typeof fixtureFor>;

async function seedTenant(fixture: Fixture): Promise<void> {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    await client.query('DELETE FROM provider_grants WHERE tenant_id = $1', [fixture.tenantId]);
    await client.query('DELETE FROM connector_configs WHERE tenant_id = $1', [fixture.tenantId]);
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
    // Zoom and WebEx: the two single-catalog OAuth cards, the shape most
    // connectors share. Both enabled org-wide, both added by this person,
    // neither connected yet — everything on the page should start in
    // "Needs setup".
    for (const connector of ['zoom', 'webex-user']) {
      await client.query(
        `INSERT INTO connector_configs (tenant_id, connector, enabled, encrypted_secrets, settings)
         VALUES ($1, $2, true, 'not-a-real-secret', '{}'::jsonb)`,
        [fixture.tenantId, connector]
      );
    }
    await client.query(
      `INSERT INTO user_preferences (tenant_id, subject, key, value)
       VALUES ($1, $2, 'connectors', '{"added": ["zoom", "webex"]}'::jsonb)`,
      [fixture.tenantId, fixture.subject]
    );
  } finally {
    await client.end();
  }
}

/** Simulates a completed Zoom OAuth: the row the real authorize callback would write. */
async function connectZoom(fixture: Fixture): Promise<void> {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    await client.query(
      `INSERT INTO provider_grants
         (tenant_id, provider, provider_account_id, subject, client_id, display_name,
          encrypted_access_token, encrypted_refresh_token, expires_at, requested_scopes)
       VALUES ($1, 'zoom', 'e2e-zoom-account', $2, 'e2e-client', 'E2E Zoom',
               'not-a-real-token', 'not-a-real-token', $3, $4)`,
      [fixture.tenantId, fixture.subject, new Date(Date.now() + 365 * 24 * 3_600_000), []]
    );
  } finally {
    await client.end();
  }
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

test('connectors page: needs-setup ordering, live scope picker, real disconnect', async ({
  page,
}, testInfo) => {
  const fixture = fixtureFor(testInfo.project.name);
  await seedTenant(fixture);
  await signIn(page, fixture);

  await page.goto(`/${fixture.slug}/connectors`);
  await expect(page.getByRole('heading', { name: 'Connectors' })).toBeVisible();

  // Both cards start unconnected: one "Needs setup" section, no "Connected"
  // section at all.
  const zoomCard = page.locator('[data-coach="card-zoom"]');
  const webexCard = page.locator('[data-coach="card-webex"]');
  await expect(page.getByRole('heading', { name: 'Needs setup' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Connected', exact: true })).toHaveCount(0);
  await expect(zoomCard.getByText('Not connected')).toBeVisible();
  await expect(webexCard.getByText('Not connected')).toBeVisible();
  await shot(page, testInfo, 'connectors-01-needs-setup');

  // The scope picker is a live client island (ScopeConnectPanel): unchecking
  // a capability must change the "Connect Zoom" link's authorize URL before
  // any network round trip.
  await zoomCard.getByText(/What Renkei may do/).click();
  const connectZoomLink = zoomCard.getByRole('link', { name: 'Connect Zoom' });
  const hrefBefore = await connectZoomLink.getAttribute('href');
  await zoomCard.getByRole('checkbox').first().uncheck();
  await expect
    .poll(() => connectZoomLink.getAttribute('href'))
    .not.toBe(hrefBefore);

  // Simulate finishing Zoom's OAuth (the row its authorize callback would
  // write) and reload: Zoom should move out of "Needs setup" into its own
  // "Connected" section, while WebEx — still unconnected — stays in
  // "Needs setup" with its own heading intact.
  await connectZoom(fixture);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Needs setup' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Connected', exact: true })).toBeVisible();
  await expect(zoomCard.getByText('Connected', { exact: true })).toBeVisible();
  await expect(webexCard.getByText('Not connected')).toBeVisible();
  await shot(page, testInfo, 'connectors-02-mixed');

  // DisconnectControl, for real: cancel first (must not disconnect), then
  // confirm, which hits the actual DELETE route and real DB.
  await zoomCard.getByRole('button', { name: 'Disconnect Zoom' }).click();
  await expect(zoomCard.getByText(/Disconnect your Zoom account\?/)).toBeVisible();
  await zoomCard.getByRole('button', { name: 'Keep it' }).click();
  await expect(zoomCard.getByText(/Disconnect your Zoom account\?/)).toHaveCount(0);
  await expect(zoomCard.getByText('Connected', { exact: true })).toBeVisible();

  await zoomCard.getByRole('button', { name: 'Disconnect Zoom' }).click();
  await zoomCard.getByRole('button', { name: 'Yes, disconnect' }).click();
  // Generous timeout: the DELETE route's best-effort Zoom-revoke path
  // (skipped here — no zoom app config on this tenant) is dev-mode
  // Next.js's first hit on this route, which JIT-compiles it.
  await expect(zoomCard.getByText('Not connected')).toBeVisible({ timeout: 30_000 });
  // Back to a single "Needs setup" section — the disconnect's router.refresh()
  // re-read the DB and re-sorted both cards into it.
  await expect(page.getByRole('heading', { name: 'Connected', exact: true })).toHaveCount(0);
  await shot(page, testInfo, 'connectors-03-disconnected');

  // Mobile: a resized Chromium viewport, not a device descriptor — see
  // AGENTS.md and llm-models.spec.ts's note on why.
  await page.setViewportSize(MOBILE_VIEWPORT);
  await expect(page.getByRole('heading', { name: 'Needs setup' })).toBeVisible();
  await expect(zoomCard).toBeVisible();
  await expect(webexCard).toBeVisible();
  await shot(page, testInfo, 'connectors-04-mobile');
});
