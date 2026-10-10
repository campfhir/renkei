/**
 * The audience control on a connector's admin page (admin → Connectors →
 * <connector>, "Who … is for") and the identity form's groups-claim hint
 * (admin → Settings) say where groups come from — and, when no groups claim
 * is configured, that nobody is in any group, so a restricted audience closes
 * the connector to everyone. The spec flips the one deployment's
 * `oidc_config.groups_claim` both ways and reads the page each time, then
 * puts the value back. It writes organization-wide state, so it gets its
 * own operator per Playwright project (the llm-models.spec.ts pattern) and
 * is not safe beside a spec that signs in through OIDC. Pinned Chromium;
 * mobile is a viewport resize.
 */

import { createHash } from 'node:crypto';
import path from 'node:path';
import { test, expect, type Page, type TestInfo } from '@playwright/test';
import { Client } from 'pg';
import { enrollForE2E } from './keys';
import { deleteRowsOf } from './seed';

const RESULTS = path.join(import.meta.dirname, '..', 'test-results');
const CLAIM = 'e2e-member-of';

test.use({
  launchOptions: {
    executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    args: ['--no-sandbox'],
  },
});
test.describe.configure({ mode: 'serial' });

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
    sessionId: uuidFrom(`audience-hint-e2e-session:${projectName}`),
    subject: `e2e-audience-${projectName}@example.com`,
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
    await deleteRowsOf(client, fixture.subject, [
      'audit_events',
      'user_preferences',
      'sessions',
      'identities',
    ]);
    await client.query(
      `INSERT INTO sessions (id, subject, roles, expires_at) VALUES ($1, $2, $3, $4)`,
      [fixture.sessionId, fixture.subject, ['renkei-user', 'renkei-operator'], new Date(Date.now() + 24 * 3_600_000)]
    );
    await client.query(
      `INSERT INTO identities (subject, email, display_name) VALUES ($1, $2, 'E2E Operator')`,
      [fixture.subject, fixture.subject]
    );
    await client.query(
      `INSERT INTO user_preferences (subject, key, value)
       VALUES ($1, 'coach_marks', '{"autoStart": false}'::jsonb)`,
      [fixture.subject]
    );
    await enrollForE2E(client, fixture.subject);
  });
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

/** The deployment's groups claim as stored; undefined when no provider row exists at all. */
async function storedGroupsClaim(): Promise<string | null | undefined> {
  const result = await withDb((client) =>
    client.query<{ groups_claim: string | null }>('SELECT groups_claim FROM oidc_config')
  );
  return result.rows[0]?.groups_claim;
}

const STAND_IN_ISSUER = 'https://idp.e2e.invalid';

/**
 * A provider row to flip the claim on. The e2e database is seeded with
 * sessions, not a provider (setup.spec.ts needs it absent), so a stand-in
 * row is written when there is none — the page only reads its claim
 * mapping — and removed again at the end.
 */
async function ensureProviderRow(): Promise<{ original: string | null; standIn: boolean }> {
  const original = await storedGroupsClaim();
  if (original !== undefined) return { original, standIn: false };
  await withDb((client) =>
    client.query(
      `INSERT INTO oidc_config (id, issuer, client_id, client_secret, role_claim, operator_idp_value, user_idp_value, groups_claim, created_at)
       VALUES (gen_random_uuid(), $1, 'e2e-client', 'not-a-real-secret', 'roles', 'renkei-operator', 'renkei-user', NULL, now())`,
      [STAND_IN_ISSUER]
    )
  );
  return { original: null, standIn: true };
}

async function removeStandIn(): Promise<void> {
  await withDb((client) => client.query('DELETE FROM oidc_config WHERE issuer = $1', [STAND_IN_ISSUER]));
}

async function setGroupsClaim(value: string | null): Promise<void> {
  await withDb((client) => client.query('UPDATE oidc_config SET groups_claim = $1', [value]));
}

async function shot(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  await page.screenshot({
    path: path.join(RESULTS, 'screens', testInfo.project.name, `audience-hint-${name}.png`),
    fullPage: true,
  });
}

test('the audience control says where groups come from, or that nobody is in one', async ({ page }, testInfo) => {
  test.setTimeout(240_000);
  const fixture = fixtureFor(testInfo.project.name);
  await seed(fixture);
  await signIn(page, fixture);

  const { original, standIn } = await ensureProviderRow();

  try {
    // ── No groups claim: nobody is in any group, and the control says so ──
    await setGroupsClaim(null);
    await page.goto('/admin/connectors/atlassian-bitbucket');
    const control = page.locator('section', { has: page.getByRole('heading', { name: /^Who .* is for$/ }) }).first();
    await expect(control).toBeVisible();
    await expect(control).toContainText('No groups claim is configured');
    await expect(control).toContainText('closes the connector to everyone');
    await expect(control).toContainText('Nobody is in a group by default');
    await shot(page, testInfo, '01-no-claim');

    // ── A named claim: the hint names it ──
    await setGroupsClaim(CLAIM);
    await page.reload();
    await expect(control).toContainText(`Groups come from the ${CLAIM} claim at sign-in`);
    await expect(control).not.toContainText('No groups claim is configured');
    const claims = await (await page.request.get('/api/admin/oidc-claims')).json();
    expect(claims.groupsClaim).toBe(CLAIM);
    await shot(page, testInfo, '02-claim');

    // ── The identity form's hint carries the same rule ──
    await page.goto('/admin/settings');
    const groupsField = page.getByLabel('Groups claim');
    await expect(groupsField).toBeVisible();
    await expect(groupsField).toHaveValue(CLAIM);
    await expect(page.getByText('Leave it empty and nobody is in any group')).toBeVisible();

    // ── Phone width: the control still reads ──
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/admin/connectors/atlassian-bitbucket');
    await expect(control).toContainText(`Groups come from the ${CLAIM} claim at sign-in`);
    await shot(page, testInfo, '03-mobile');
  } finally {
    if (standIn) await removeStandIn();
    else await setGroupsClaim(original);
  }
  expect(await storedGroupsClaim()).toBe(standIn ? undefined : original);
});
