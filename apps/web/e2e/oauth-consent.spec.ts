/**
 * The MCP OAuth consent page: a signed-in browser sent to the authorize
 * endpoint by a client lands on a page naming the client, Deny returns
 * `access_denied` to the client's loopback callback, Allow returns a code,
 * and the same page at phone width still reads. This spec writes data
 * (a client, consent requests, a code), so it gets its own tenant per
 * Playwright project (the llm-models.spec.ts pattern). Pinned Chromium;
 * mobile is a viewport resize.
 */

import { createHash, randomBytes } from 'node:crypto';
import path from 'node:path';
import { test, expect, type Page, type TestInfo } from '@playwright/test';
import { Client } from 'pg';

const RESULTS = path.join(import.meta.dirname, '..', 'test-results');
/** A port no real listener holds; the callback is intercepted with page.route. */
const CALLBACK = 'http://127.0.0.1:47391/callback';

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
    tenantId: uuidFrom(`oauth-consent-e2e-tenant:${projectName}`),
    slug: `e2e-oauth-consent-${projectName}`,
    sessionId: uuidFrom(`oauth-consent-e2e-session:${projectName}`),
    subject: `e2e-consent-${projectName}@example.com`,
    clientId: `client_e2e_consent_${projectName}`,
  };
}

type Fixture = ReturnType<typeof fixtureFor>;

async function withDb<T>(fn: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

async function seed(fixture: Fixture): Promise<void> {
  await withDb(async (client) => {
    // Nothing an OAuth client owns cascades from the tenant, so the previous
    // run's rows go first, newest dependency first.
    for (const table of [
      'audit_events',
      'oauth_access_tokens',
      'oauth_refresh_tokens',
      'oauth_authorization_codes',
      'oauth_consent_requests',
      'oauth_clients',
      'sessions',
      'identities',
      'tenant_settings',
    ]) {
      await client.query(`DELETE FROM ${table} WHERE tenant_id = $1`, [fixture.tenantId]);
    }
    await client.query('DELETE FROM tenants WHERE id = $1', [fixture.tenantId]);
    await client.query(
      'INSERT INTO tenants (id, slug, domain_verified_at) VALUES ($1, $2, NOW())',
      [fixture.tenantId, fixture.slug]
    );
    await client.query(
      `INSERT INTO sessions (id, tenant_id, subject, roles, expires_at) VALUES ($1, $2, $3, $4, $5)`,
      [
        fixture.sessionId,
        fixture.tenantId,
        fixture.subject,
        ['renkei-user'],
        new Date(Date.now() + 3_600_000),
      ]
    );
    await client.query(
      `INSERT INTO identities (tenant_id, subject, email, display_name) VALUES ($1, $2, $3, $4)`,
      [fixture.tenantId, fixture.subject, fixture.subject, 'E2E Person']
    );
    // Registered "just now", so the page shows its freshly-registered note.
    await client.query(
      `INSERT INTO oauth_clients (client_id, tenant_id, client_name, client_secret_hash, redirect_uris)
       VALUES ($1, $2, 'Claude Code (e2e)', 'unused', ARRAY['http://127.0.0.1/callback'])`,
      [fixture.clientId, fixture.tenantId]
    );
  });
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

/** What a client would send: the authorize URL with an S256 challenge. */
function authorizeUrl(fixture: Fixture, state: string): string {
  const verifier = randomBytes(32).toString('base64url');
  const query = new URLSearchParams({
    response_type: 'code',
    client_id: fixture.clientId,
    redirect_uri: CALLBACK,
    state,
    scope: 'openid profile email',
    code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    code_challenge_method: 'S256',
  });
  return `/api/mcp/${fixture.tenantId}/oauth/authorize?${query.toString()}`;
}

/** Catch the client's loopback callback in the browser instead of letting it fail to connect. */
async function interceptCallback(page: Page): Promise<() => URL | null> {
  let landed: URL | null = null;
  await page.route(`${CALLBACK}**`, async (route) => {
    landed = new URL(route.request().url());
    await route.fulfill({
      status: 200,
      contentType: 'text/html',
      body: '<!doctype html><title>callback</title><p data-testid="callback">callback reached</p>',
    });
  });
  return () => landed;
}

test('an MCP client must be allowed on the consent page before it gets a code', async ({
  page,
}, testInfo) => {
  const fixture = fixtureFor(testInfo.project.name);
  await seed(fixture);
  await signIn(page, fixture);
  const callback = await interceptCallback(page);

  // Deny first: the client hears access_denied and nothing was minted.
  await page.goto(authorizeUrl(fixture, 'state-deny'));
  await expect(
    page.getByRole('heading', { name: 'Allow Claude Code (e2e) to act as you?' })
  ).toBeVisible();
  await expect(page.getByText('E2E Person')).toBeVisible();
  await expect(page.getByText('an application running on this computer')).toBeVisible();
  await expect(page.getByRole('note')).toContainText('registered itself less than an hour ago');
  await shot(page, testInfo, 'oauth-consent-01-page');

  await page.getByRole('button', { name: 'Deny' }).click();
  await expect(page.getByTestId('callback')).toBeVisible();
  const denied = callback();
  expect(denied?.searchParams.get('error')).toBe('access_denied');
  expect(denied?.searchParams.get('state')).toBe('state-deny');
  expect(denied?.searchParams.get('code')).toBeNull();

  // Allow: the callback receives a code bound to this person.
  await page.goto(authorizeUrl(fixture, 'state-allow'));
  await expect(page.getByRole('button', { name: 'Allow' })).toBeVisible();
  await page.getByRole('button', { name: 'Allow' }).click();
  await expect(page.getByTestId('callback')).toBeVisible();
  const allowed = callback();
  expect(allowed?.searchParams.get('state')).toBe('state-allow');
  expect(allowed?.searchParams.get('code')).toMatch(/^code_/);

  const minted = await withDb((client) =>
    client.query(
      'SELECT subject, code_challenge_method FROM oauth_authorization_codes WHERE tenant_id = $1',
      [fixture.tenantId]
    )
  );
  expect(minted.rows).toEqual([{ subject: fixture.subject, code_challenge_method: 'S256' }]);

  // A consent page that was left open and then answered twice is spent.
  const audit = await withDb((client) =>
    client.query(
      'SELECT action FROM audit_events WHERE tenant_id = $1 AND action LIKE $2 ORDER BY action',
      [fixture.tenantId, 'oauth.consent_%']
    )
  );
  expect(audit.rows.map((row) => row.action)).toEqual([
    'oauth.consent_denied',
    'oauth.consent_granted',
  ]);

  // Phone width: the same page, buttons stacked, nothing clipped.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(authorizeUrl(fixture, 'state-mobile'));
  await expect(page.getByRole('button', { name: 'Allow' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Deny' })).toBeVisible();
  await shot(page, testInfo, 'oauth-consent-02-mobile');
});

test('a request without PKCE never reaches the consent page', async ({ page }, testInfo) => {
  const fixture = fixtureFor(testInfo.project.name);
  await seed(fixture);
  await signIn(page, fixture);

  // Asked the way the browser would (same cookies), but without following
  // the redirect: what matters is where the server sends it and with what.
  const query = new URLSearchParams({
    response_type: 'code',
    client_id: fixture.clientId,
    redirect_uri: CALLBACK,
    state: 'no-pkce',
  });
  const response = await page.request.get(
    `/api/mcp/${fixture.tenantId}/oauth/authorize?${query.toString()}`,
    { maxRedirects: 0 }
  );
  expect(response.status()).toBe(303);
  const landed = new URL(response.headers()['location']);
  expect(landed.origin).toBe(new URL(CALLBACK).origin);
  expect(landed.searchParams.get('error')).toBe('invalid_request');
  expect(landed.searchParams.get('error_description')).toMatch(/code_challenge/);
  expect(landed.searchParams.get('state')).toBe('no-pkce');
  expect(landed.searchParams.get('code')).toBeNull();

  const pending = await withDb((client) =>
    client.query('SELECT count(*) FROM oauth_consent_requests WHERE tenant_id = $1', [
      fixture.tenantId,
    ])
  );
  expect(Number(pending.rows[0].count)).toBe(0);
});
