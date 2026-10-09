/**
 * The Outlook background opt-in on the connectors page, after mail,
 * calendar and To Do all left the knowledge index: one Mail toggle that
 * only wires new mail to the "An email arrives" agent trigger (and says
 * so), NO Tasks or Calendar toggle, and no indexing progress or re-index
 * control, since nothing in Outlook indexes. Driven against the real
 * /api/microsoft/[tenantId]/indexing route — a PUT writes the grant's
 * metadata and enqueues the bootstrap event; neither touches Microsoft for
 * a grant whose token is a placeholder, since the worker is not running
 * here — and the saved shape is read back from Postgres.
 *
 * Own tenant, same reasoning as llm-models.spec.ts / connectors.spec.ts:
 * this spec writes rows through the UI, and projects run concurrently
 * against one dev database.
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

function fixtureFor(projectName: string): {
  sessionId: string;
  slug: string;
  subject: string;
  accountId: string;
} {
  return {
    sessionId: uuidFrom(`outlook-indexing-e2e-session:${projectName}`),
    slug: `e2e-outlook-indexing-${projectName}`,
    subject: `e2e-outlook-indexing-${projectName}@example.com`,
    accountId: `e2e-m365-${projectName}`,
  };
}

type Fixture = ReturnType<typeof fixtureFor>;

async function withDb<T>(run: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    return await run(client);
  } finally {
    await client.end();
  }
}

async function seedTenant(fixture: Fixture): Promise<void> {
  await withDb(async (client) => {
    await client.query('DELETE FROM events');
    await client.query('DELETE FROM webhook_subscriptions WHERE subject = $1', [fixture.subject]);
    await client.query('DELETE FROM provider_grants WHERE subject = $1', [fixture.subject]);
    await client.query('DELETE FROM connector_configs');
    await client.query('DELETE FROM user_preferences WHERE subject = $1', [fixture.subject]);
    await client.query('DELETE FROM sessions WHERE subject = $1', [fixture.subject]);
    await client.query('DELETE FROM identities WHERE subject = $1', [fixture.subject]);
    await client.query(
      `INSERT INTO sessions (id, subject, roles, expires_at)\n       VALUES ($1, $2, $3, $4)`,
      [fixture.sessionId, fixture.subject, ['renkei-user'], new Date(Date.now() + 24 * 3_600_000)]
    );
    await client.query(
      `INSERT INTO identities (subject, email, display_name)\n       VALUES ($1, $2, $3)`,
      [fixture.subject, fixture.subject, 'E2E Tester']
    );
    // No coach marks tour stealing focus mid-screenshot.
    await client.query(
      `INSERT INTO user_preferences (subject, key, value)\n       VALUES ($1, 'coach_marks', '{\"autoStart\": false}'::jsonb)`,
      [fixture.subject]
    );
    // Microsoft 365 is set up for the org and connected for this person.
    await client.query(
      `INSERT INTO connector_configs (connector, enabled, encrypted_secrets, settings)\n       VALUES ('microsoft', true, 'not-a-real-secret', $1::jsonb)`,
      [JSON.stringify({ clientId: 'e2e-m365', directoryTenantId: 'e2e-dir' })]
    );
    // A grant from BEFORE calendar left the index: it still carries a
    // `calendar: true` flag, which the page must neither show nor keep.
    await client.query(
      `INSERT INTO provider_grants\n         (provider, provider_account_id, subject, client_id, display_name,\n          encrypted_access_token, encrypted_refresh_token, expires_at, requested_scopes,\n          metadata)\n       VALUES ('microsoft', $1, $2, 'e2e-m365', 'E2E M365 User',\n               'not-a-real-token', 'not-a-real-token', $3, $4, $5)`,
      [fixture.accountId, fixture.subject, new Date(Date.now() + 365 * 24 * 3_600_000), ['Mail.Read', 'Tasks.Read', 'offline_access'], { tid: 'e2e-dir', upn: 'e2e@example.com', indexing: { calendar: true, tasks: true } }]
    );
    await client.query(
      `INSERT INTO user_preferences (subject, key, value)\n       VALUES ($1, 'connectors', '{\"added\": [\"microsoft\"]}'::jsonb)`,
      [fixture.subject]
    );
    // Subscription rows as the worker would have left them: the inbox
    // trigger feed, having completed a round, and a To Do list from before
    // tasks left the index (the ensure pass tears it down on its next
    // sweep). Neither indexes anything, so neither may appear under an
    // "Indexing" heading, where "N indexed" beside it would be false.
    for (const [resource, total] of [
      ["me/mailFolders('inbox')/messages", 12],
      ['me/todo/lists/list-1/tasks', 7],
    ] as const) {
      await client.query(
        `INSERT INTO webhook_subscriptions\n           (id, provider, account_id, resource, subscription_id, client_state,\n            expires_at, delta_link, last_synced_at, last_run_items, total_items, sync_status)\n         VALUES (gen_random_uuid(), 'microsoft', $1, $2, 'graph-sub', 'state',\n                 NOW() + interval '2 days', 'delta-1', NOW(), 0, $3, 'idle')`,
        [fixture.accountId, resource, total]
      );
    }
  });
}

async function savedIndexing(fixture: Fixture): Promise<unknown> {
  return withDb(async (client) => {
    const result = await client.query<{ indexing: unknown }>(
      `SELECT metadata -> 'indexing' AS indexing FROM provider_grants\n        WHERE provider = 'microsoft' AND subject = $1`,
      [fixture.subject]
    );
    return result.rows[0]?.indexing;
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

test('Outlook opt-in: Mail is a trigger feed; Tasks and Calendar are gone', async ({
  page,
}, testInfo) => {
  const fixture = fixtureFor(testInfo.project.name);
  await seedTenant(fixture);
  await signIn(page, fixture);

  await page.goto(`/connectors`);
  await expect(page.getByRole('heading', { name: 'Connectors' })).toBeVisible();

  const card = page.locator('[data-coach="card-microsoft"]');
  const prefs = card.locator('[data-coach="outlook-indexing"]');
  await expect(prefs.getByText('What runs in the background')).toBeVisible();

  // Exactly one toggle, saying what it now means.
  const mail = prefs.getByRole('checkbox', { name: /^Mail/ });
  await expect(prefs.getByRole('checkbox')).toHaveCount(1);
  await expect(prefs.getByText(/Calendar/)).toHaveCount(0);
  await expect(prefs.getByText(/Tasks|To Do/)).toHaveCount(0);
  await expect(prefs.getByText(/"An email arrives" trigger/)).toBeVisible();
  await expect(prefs.getByText(/never indexed/)).toBeVisible();
  // The stale calendar and tasks flags on the grant are not honoured as any opt-in.
  await expect(mail).toBeEnabled();
  await expect(mail).not.toBeChecked();

  // Nothing in Outlook indexes, so the card carries no indexing progress
  // and no re-index control: neither the inbox feed nor the leftover To Do
  // row may read as "N indexed".
  await expect(card.locator('li', { hasText: /indexed/ })).toHaveCount(0);
  await expect(card.getByText('Indexing', { exact: true })).toHaveCount(0);
  await expect(card.getByRole('button', { name: 'Re-index' })).toHaveCount(0);
  await shot(page, testInfo, 'outlook-indexing-01-off');

  // Opt into the trigger feed: the real PUT, then the saved shape — mail
  // on, and the old calendar and tasks keys gone rather than carried.
  await mail.check();
  await expect(prefs.getByText(/start waking agents/)).toBeVisible({ timeout: 30_000 });
  await expect(prefs.getByText(/Nothing is indexed/)).toBeVisible();
  await expect.poll(() => savedIndexing(fixture)).toEqual({ mail: true });
  await shot(page, testInfo, 'outlook-indexing-02-mail-on');

  await mail.uncheck();
  await expect(prefs.getByText('New mail no longer wakes your agents.')).toBeVisible({
    timeout: 30_000,
  });
  await expect.poll(() => savedIndexing(fixture)).toEqual({ mail: false });

  // Mobile: a resized Chromium viewport, not a device descriptor — see
  // AGENTS.md and llm-models.spec.ts's note on why.
  await page.setViewportSize(MOBILE_VIEWPORT);
  await expect(prefs.getByText('What runs in the background')).toBeVisible();
  await expect(mail).toBeVisible();
  await shot(page, testInfo, 'outlook-indexing-03-mobile');
});
