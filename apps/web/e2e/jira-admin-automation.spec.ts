/* eslint-disable @typescript-eslint/consistent-type-assertions */
/**
 * Automation rules on an Atlassian API token, end to end in a browser:
 *
 * - the Jira Administration card takes the person's API token; one the
 *   stand-in Atlassian (e2e/sandbox-stub.mjs, through
 *   JIRA_AUTOMATION_API_BASE_URL) refuses is not kept, one it accepts is
 *   saved — and the delegate sent it as HTTP Basic, email:token;
 * - an automation change request (disabling a rule) is reviewed, then
 *   applied on that token, and the stand-in's rule is disabled;
 * - the token is removed from the card again;
 * - without a token, the review page says so in place of Apply.
 *
 * The proposal is seeded as the row jira_admin_propose_automation_rule_state
 * writes (the tools are covered by automation-tools.test.ts).
 *
 * Own person per project, and a fresh Jira site id per run: the stub keeps
 * each site's rules in memory.
 *
 * Runs on the pinned Chromium only (no WebKit installed in this sandbox —
 * see voice.spec.ts's note); "mobile" is a resized viewport, per AGENTS.md.
 */

import { createHash } from 'node:crypto';
import path from 'node:path';
import { test, expect, type Page, type TestInfo } from './worker-env';
import { Client } from 'pg';
import { sealForSubject } from './keys';
import { isolateFile } from './worker-env';

// Each file starts from a database of its own: this runs before the file's other hooks.
test.beforeAll(isolateFile);


const RESULTS = path.join(import.meta.dirname, '..', 'test-results');
const MOBILE_VIEWPORT = { width: 390, height: 844 };
const STUB = 'http://127.0.0.1:8092/automation/jira';
const EMAIL = 'dana@example.com';
const TOKEN = 'ATATT3x-e2e-token';

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
    sessionId: uuidFrom(`jira-admin-automation-e2e-session:${projectName}`),
    subject: `e2e-jira-automation-${projectName}@example.com`,
    cloudId: `e2e-automation-${projectName}-${Date.now()}`,
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
    await client.query('DELETE FROM jira_admin_change_requests WHERE subject = $1', [
      fixture.subject,
    ]);
    await client.query('DELETE FROM audit_events WHERE actor_subject = $1', [fixture.subject]);
    await client.query('DELETE FROM provider_grants WHERE subject = $1', [fixture.subject]);
    await client.query('DELETE FROM connector_configs');
    await client.query('DELETE FROM user_preferences WHERE subject = $1', [fixture.subject]);
    await client.query('DELETE FROM sessions WHERE subject = $1', [fixture.subject]);
    await client.query('DELETE FROM identities WHERE subject = $1', [fixture.subject]);
    await client.query(
      `INSERT INTO sessions (id, subject, roles, expires_at) VALUES ($1, $2, $3, $4)`,
      [fixture.sessionId, fixture.subject, ['renkei-user', 'renkei-operator'], new Date(Date.now() + 24 * 3_600_000)]
    );
    await client.query(
      `INSERT INTO identities (subject, email, display_name) VALUES ($1, $2, $3)`,
      [fixture.subject, fixture.subject, 'E2E Jira Admin']
    );
    await client.query(
      `INSERT INTO user_preferences (subject, key, value)
       VALUES ($1, 'coach_marks', '{"autoStart": false}'::jsonb)`,
      [fixture.subject]
    );
    await client.query(
      `INSERT INTO connector_configs (connector, enabled, encrypted_secrets, settings)
       VALUES ('atlassian-admin', true, 'not-a-real-secret', '{}'::jsonb)`
    );
    await client.query(
      `INSERT INTO provider_grants
         (provider, provider_account_id, subject, client_id, display_name,
          encrypted_access_token, encrypted_refresh_token, expires_at, requested_scopes,
          metadata)
       VALUES ('atlassian-admin', $1, $2, 'e2e-admin-client', 'E2E Jira Admin', $3, $4, $5, $6, $7)`,
      [
        `e2e-admin-account-${fixture.subject}`,
        fixture.subject,
        await sealForSubject(client, fixture.subject, 'e2e-admin-access-token'),
        await sealForSubject(client, fixture.subject, 'e2e-admin-refresh-token'),
        new Date(Date.now() + 365 * 24 * 3_600_000),
        ['read:jira-user', 'read:jira-work', 'manage:jira-configuration', 'offline_access'],
        { cloudId: fixture.cloudId, siteUrl: 'https://e2e.atlassian.net' },
      ]
    );
  });
}

/** The row jira_admin_propose_automation_rule_state writes for disabling the stub's first rule. */
async function proposeDisable(fixture: Fixture): Promise<string> {
  const payload = {
    rules: [{ uuid: 'rule-1', name: 'Escalate outages', from: 'ENABLED', to: 'DISABLED' }],
  };
  const result = await withDb((client) =>
    client.query<{ id: string }>(
      `INSERT INTO jira_admin_change_requests
         (subject, cloud_id, site_url, kind, title, reason, payload, expires_at)
       VALUES ($1, $2, 'https://e2e.atlassian.net', 'automation_state',
               'Disable the automation rule “Escalate outages”', 'Freeze week', $3, $4)
       RETURNING id`,
      [
        fixture.subject,
        fixture.cloudId,
        JSON.stringify(payload),
        new Date(Date.now() + 24 * 3_600_000),
      ]
    )
  );
  const id = result.rows[0]?.id;
  if (!id) throw new Error('no change request inserted');
  return id;
}

/** The stand-in's view, as the token's owner would see it. */
async function stubRule(fixture: Fixture, uuid: string): Promise<Record<string, unknown>> {
  const response = await fetch(`${STUB}/${fixture.cloudId}/rest/v1/rule/${uuid}`, {
    headers: { authorization: `Basic ${Buffer.from(`${EMAIL}:${TOKEN}`).toString('base64')}` },
  });
  const body = (await response.json()) as { rule?: Record<string, unknown> };
  return body.rule ?? {};
}

async function lastAuthorization(fixture: Fixture): Promise<string | null> {
  const response = await fetch(`${STUB}/${fixture.cloudId}/__last-authorization`);
  const body = (await response.json()) as { authorization: string | null };
  return body.authorization;
}

async function tokenRows(fixture: Fixture): Promise<number> {
  return withDb(async (client) => {
    const rows = await client.query(
      `SELECT 1 FROM provider_grants WHERE provider = 'atlassian-admin-token' AND subject = $1`,
      [fixture.subject]
    );
    return rows.rowCount ?? 0;
  });
}

async function signIn(page: Page, fixture: Fixture): Promise<void> {
  await page.context().addCookies([
    {
      name: `renkei_session`,
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

function main(page: Page) {
  return page.getByRole('main');
}

test.describe.configure({ mode: 'serial' });

test('an API token is refused, then saved and sent as Basic; a rule is disabled on it; the token is removed', async ({
  page,
}, testInfo) => {
  const fixture = fixtureFor(testInfo.project.name);
  await seedTenant(fixture);
  await signIn(page, fixture);

  // --- The card takes the token; one Atlassian refuses is not kept. ---
  await page.goto(`/connectors`);
  const panel = page.locator('[data-coach="card-jira-admin"]');
  await expect(panel.getByText('Connected as')).toBeVisible();
  const tokenBox = panel.getByTestId('jira-admin-api-token');
  await expect(tokenBox.getByText('Automation rules: an Atlassian API token')).toBeVisible();
  await tokenBox.getByLabel('Atlassian account email').fill(EMAIL);
  await tokenBox.getByLabel('API token').fill('nope');
  await tokenBox.getByRole('button', { name: 'Save API token' }).click();
  await expect(tokenBox.getByRole('alert')).toContainText(
    'Atlassian refused that token, so it was not kept.'
  );
  expect(await tokenRows(fixture)).toBe(0);
  await shot(page, testInfo, 'jira-admin-automation-01-refused');

  // One it accepts is saved — and reached it as Basic, email:token.
  await tokenBox.getByLabel('API token').fill(TOKEN);
  await tokenBox.getByRole('button', { name: 'Save API token' }).click();
  await expect(tokenBox.getByTestId('jira-admin-api-token-saved')).toContainText(
    `API token saved for ${EMAIL}.`,
    { timeout: 30_000 }
  );
  expect(await tokenRows(fixture)).toBe(1);
  expect(await lastAuthorization(fixture)).toBe(
    `Basic ${Buffer.from(`${EMAIL}:${TOKEN}`).toString('base64')}`
  );
  await shot(page, testInfo, 'jira-admin-automation-02-saved');

  // --- A change reviewed, then applied on the token. ---
  const id = await proposeDisable(fixture);
  await page.goto(`/jira-admin/changes/${id}`);
  await expect(main(page).getByTestId('change-title')).toHaveText(
    'Disable the automation rule “Escalate outages”'
  );
  await expect(main(page).getByTestId('change-reach')).toContainText(
    'Runs on your Atlassian API token, as you.'
  );
  const operations = main(page).getByTestId('change-operations').locator(':scope > li');
  await expect(operations).toHaveCount(1);
  await expect(operations.nth(0)).toContainText('Disable the automation rule “Escalate outages”');
  expect((await stubRule(fixture, 'rule-1')).state).toBe('ENABLED');
  await shot(page, testInfo, 'jira-admin-automation-03-review');

  await page.getByRole('button', { name: 'Apply this change to Jira' }).click();
  await expect(main(page).getByTestId('change-state')).toHaveText('Applied', { timeout: 30_000 });
  await expect(operations.nth(0)).toContainText('Done');
  expect((await stubRule(fixture, 'rule-1')).state).toBe('DISABLED');
  await expect
    .poll(async () =>
      withDb(async (client) => {
        const rows = await client.query(
          `SELECT 1 FROM audit_events WHERE action = 'jira_admin.change_applied' AND actor_subject = $1`,
          [fixture.subject]
        );
        return rows.rowCount;
      })
    )
    .toBe(1);
  await shot(page, testInfo, 'jira-admin-automation-04-applied');

  // Mobile: a resized Chromium viewport, not a device descriptor.
  await page.setViewportSize(MOBILE_VIEWPORT);
  await noHorizontalOverflow(page);
  await shot(page, testInfo, 'jira-admin-automation-05-mobile');

  // --- Removed from the card again. ---
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`/connectors`);
  await tokenBox.getByRole('button', { name: 'Remove API token' }).click();
  await tokenBox.getByRole('button', { name: 'Yes, remove it' }).click();
  await expect(tokenBox.getByRole('button', { name: 'Save API token' })).toBeVisible({
    timeout: 30_000,
  });
  expect(await tokenRows(fixture)).toBe(0);
  await shot(page, testInfo, 'jira-admin-automation-06-removed');
});

test('without a token, the review page says so in place of Apply', async ({ page }, testInfo) => {
  const fixture = fixtureFor(testInfo.project.name);
  await seedTenant(fixture);
  const id = await proposeDisable(fixture);
  await signIn(page, fixture);

  await page.goto(`/jira-admin/changes/${id}`);
  await expect(page.getByRole('button', { name: 'Apply this change to Jira' })).toBeDisabled();
  await expect(main(page)).toContainText(
    'No Atlassian API token is saved. Automation rules are read and changed with one'
  );
  await shot(page, testInfo, 'jira-admin-automation-07-no-token');
});
