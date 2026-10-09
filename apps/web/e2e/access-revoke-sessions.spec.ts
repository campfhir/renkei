/**
 * The Access page's "Sign out everywhere": an operator ends another person's
 * browser sessions and MCP tokens from the row, and the rows are really
 * gone afterwards. This spec writes data, so it gets its own tenant per
 * Playwright project (the llm-models.spec.ts pattern) rather than the
 * shared seed. Pinned Chromium; mobile is a viewport resize.
 */

import { createHash } from 'node:crypto';
import path from 'node:path';
import { test, expect, type Page, type TestInfo } from '@playwright/test';
import { Client } from 'pg';

const RESULTS = path.join(import.meta.dirname, '..', 'test-results');

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
    tenantId: uuidFrom(`access-revoke-e2e-tenant:${projectName}`),
    slug: `e2e-access-revoke-${projectName}`,
    operator: {
      sessionId: uuidFrom(`access-revoke-e2e-op-session:${projectName}`),
      subject: `e2e-access-revoke-op-${projectName}@example.com`,
    },
    target: {
      sessionId: uuidFrom(`access-revoke-e2e-target-session:${projectName}`),
      subject: `e2e-access-revoke-target-${projectName}@example.com`,
      clientId: `client_e2e_access_revoke_${projectName}`,
    },
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
    await client.query('DELETE FROM oauth_access_tokens WHERE tenant_id = $1', [fixture.tenantId]);
    await client.query('DELETE FROM oauth_refresh_tokens WHERE tenant_id = $1', [fixture.tenantId]);
    await client.query('DELETE FROM oauth_clients WHERE tenant_id = $1', [fixture.tenantId]);
    await client.query('DELETE FROM audit_events WHERE tenant_id = $1', [fixture.tenantId]);
    await client.query('DELETE FROM sessions WHERE tenant_id = $1', [fixture.tenantId]);
    await client.query('DELETE FROM identities WHERE tenant_id = $1', [fixture.tenantId]);
    await client.query('DELETE FROM tenants WHERE id = $1', [fixture.tenantId]);
    await client.query(
      'INSERT INTO tenants (id, slug, domain_verified_at) VALUES ($1, $2, NOW())',
      [fixture.tenantId, fixture.slug]
    );
    const inAnHour = new Date(Date.now() + 3_600_000);
    for (const [person, roles] of [
      [fixture.operator, ['renkei-user', 'renkei-operator']],
      [fixture.target, ['renkei-user']],
    ] as const) {
      await client.query(
        `INSERT INTO sessions (id, tenant_id, subject, roles, expires_at) VALUES ($1, $2, $3, $4, $5)`,
        [person.sessionId, fixture.tenantId, person.subject, roles, inAnHour]
      );
      await client.query(
        `INSERT INTO identities (tenant_id, subject, email, display_name) VALUES ($1, $2, $3, $4)`,
        [fixture.tenantId, person.subject, person.subject, person.subject.split('@')[0]]
      );
    }
    // The target also holds an MCP client connection: an access token and a
    // refresh token, both of which the button must end.
    await client.query(
      `INSERT INTO oauth_clients (client_id, tenant_id, client_name, client_secret_hash, redirect_uris)
       VALUES ($1, $2, 'e2e', 'unused', ARRAY['https://client.example/cb'])`,
      [fixture.target.clientId, fixture.tenantId]
    );
    await client.query(
      `INSERT INTO oauth_access_tokens (token_hash, tenant_id, client_id, subject, expires_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        `hash-${fixture.target.sessionId}`,
        fixture.tenantId,
        fixture.target.clientId,
        fixture.target.subject,
        inAnHour,
      ]
    );
    await client.query(
      `INSERT INTO oauth_refresh_tokens (token_id, tenant_id, client_id, subject, token_hash, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        uuidFrom(`rt:${fixture.tenantId}`),
        fixture.tenantId,
        fixture.target.clientId,
        fixture.target.subject,
        `rhash-${fixture.target.sessionId}`,
        inAnHour,
      ]
    );
    await client.query(
      `INSERT INTO user_preferences (tenant_id, subject, key, value)
       VALUES ($1, $2, 'coach_marks', '{"autoStart": false}'::jsonb)`,
      [fixture.tenantId, fixture.operator.subject]
    );
  });
}

async function remaining(fixture: Fixture) {
  return withDb(async (client) => {
    const count = async (table: string) =>
      Number(
        (
          await client.query(
            `SELECT count(*) FROM ${table} WHERE tenant_id = $1 AND subject = $2`,
            [fixture.tenantId, fixture.target.subject]
          )
        ).rows[0].count
      );
    const audit = await client.query(
      `SELECT action, target_label FROM audit_events WHERE tenant_id = $1 AND action = 'user.sessions_revoked'`,
      [fixture.tenantId]
    );
    return {
      sessions: await count('sessions'),
      accessTokens: await count('oauth_access_tokens'),
      refreshTokens: await count('oauth_refresh_tokens'),
      audit: audit.rows,
    };
  });
}

async function signInAsOperator(page: Page, fixture: Fixture): Promise<void> {
  await page.context().addCookies([
    {
      name: `renkei_session_${fixture.tenantId}`,
      value: fixture.operator.sessionId,
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

test('admin access: sign a person out everywhere', async ({ page }, testInfo) => {
  const fixture = fixtureFor(testInfo.project.name);
  await seed(fixture);
  await signInAsOperator(page, fixture);

  await page.goto(`/${fixture.slug}/admin/access`);
  await expect(page.getByRole('heading', { name: 'Access' })).toBeVisible();

  const button = page.getByTestId(`revoke-sessions-${fixture.target.subject}`);
  await expect(button).toBeVisible();
  // Never offered on the operator's own row.
  await expect(page.getByTestId(`revoke-sessions-${fixture.operator.subject}`)).toHaveCount(0);
  await shot(page, testInfo, 'access-revoke-01-before');

  page.once('dialog', (dialog) => void dialog.accept());
  await button.click();

  const outcome = page.getByTestId(`revoke-sessions-outcome-${fixture.target.subject}`);
  await expect(outcome).toHaveText('Signed out: 1 session, 2 tokens');
  await shot(page, testInfo, 'access-revoke-02-after');

  const left = await remaining(fixture);
  expect(left.sessions).toBe(0);
  expect(left.accessTokens).toBe(0);
  expect(left.refreshTokens).toBe(0);
  expect(left.audit).toEqual([
    { action: 'user.sessions_revoked', target_label: fixture.target.subject },
  ]);

  // The operator's own session survived the operation.
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Access' })).toBeVisible();

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByTestId(`revoke-sessions-${fixture.target.subject}`)).toBeVisible();
  await shot(page, testInfo, 'access-revoke-03-mobile');
});
