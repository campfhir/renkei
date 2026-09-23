/**
 * Jira admin change requests, end to end in a browser: a proposal waits on
 * the review page until its owner applies it, and applying runs the stored
 * operations against Jira — here the stand-in in e2e/sandbox-stub.mjs,
 * which the app reaches through JIRA_ADMIN_API_BASE_URL, so nothing leaves
 * this machine. The proposals are seeded as the rows the propose tool
 * writes (its own behavior is covered by changes.test.ts), the way
 * jira-admin.spec.ts seeds the row the OAuth callback writes.
 *
 * Then the refusals, each of which must leave the request pending and
 * Jira untouched: a proposal for another Jira site, a connection without
 * the scope the writes need, one that expired, and one that is someone
 * else's. And a proposal Jira moved underneath — an option added by hand
 * since — stops at that operation and runs nothing after it.
 *
 * Own tenant per project (projects run concurrently against one dev
 * Postgres), and a fresh Jira site id per run, so a stub left running from
 * an earlier run never hands this one yesterday's options.
 *
 * Runs on the pinned Chromium only (no WebKit installed in this sandbox —
 * see voice.spec.ts's note); "mobile" is a resized viewport, per AGENTS.md.
 */

import { createCipheriv, createHash, randomBytes } from 'node:crypto';
import path from 'node:path';
import { test, expect, type Page, type TestInfo } from '@playwright/test';
import { Client } from 'pg';

const RESULTS = path.join(import.meta.dirname, '..', 'test-results');
const MOBILE_VIEWPORT = { width: 390, height: 844 };
const STUB = 'http://127.0.0.1:8092/jira';
const FIELD_ID = 'customfield_10100';
const CONTEXT_ID = '10200';

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

/**
 * `@renkei/crypto`'s secretbox, reproduced (see code.spec.ts): what a
 * stored grant token looks like, so the apply route can open the seeded
 * Jira Administration grant.
 */
function secretbox(plaintext: string): string {
  const encoded = process.env.TOKEN_ENCRYPTION_KEY;
  if (!encoded) throw new Error('TOKEN_ENCRYPTION_KEY is not set');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(encoded, 'base64'), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return [
    'v1',
    iv.toString('base64'),
    cipher.getAuthTag().toString('base64'),
    ciphertext.toString('base64'),
  ].join('.');
}

function fixtureFor(projectName: string) {
  return {
    tenantId: uuidFrom(`jira-admin-changes-e2e-tenant:${projectName}`),
    sessionId: uuidFrom(`jira-admin-changes-e2e-session:${projectName}`),
    slug: `e2e-jira-changes-${projectName}`,
    subject: `e2e-jira-changes-${projectName}@example.com`,
    // Fresh per run: the stub keeps each site's options in memory.
    cloudId: `e2e-cloud-${projectName}-${Date.now()}`,
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

const FULL_SCOPES = ['read:jira-user', 'read:jira-work', 'manage:jira-configuration'];

async function seedTenant(fixture: Fixture): Promise<void> {
  await withDb(async (client) => {
    const tenant = [fixture.tenantId];
    await client.query('DELETE FROM jira_admin_change_requests WHERE tenant_id = $1', tenant);
    await client.query('DELETE FROM audit_events WHERE tenant_id = $1', tenant);
    await client.query('DELETE FROM provider_grants WHERE tenant_id = $1', tenant);
    await client.query('DELETE FROM connector_configs WHERE tenant_id = $1', tenant);
    await client.query('DELETE FROM user_preferences WHERE tenant_id = $1', tenant);
    await client.query('DELETE FROM sessions WHERE tenant_id = $1', tenant);
    await client.query('DELETE FROM identities WHERE tenant_id = $1', tenant);
    await client.query('DELETE FROM tenants WHERE id = $1', tenant);
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
        ['renkei-user'],
        new Date(Date.now() + 24 * 3_600_000),
      ]
    );
    await client.query(
      `INSERT INTO identities (tenant_id, subject, email, display_name)
       VALUES ($1, $2, $3, $4)`,
      [fixture.tenantId, fixture.subject, fixture.subject, 'E2E Jira Admin']
    );
    // No coach marks tour stealing focus mid-screenshot.
    await client.query(
      `INSERT INTO user_preferences (tenant_id, subject, key, value)
       VALUES ($1, $2, 'coach_marks', '{"autoStart": false}'::jsonb)`,
      [fixture.tenantId, fixture.subject]
    );
    await client.query(
      `INSERT INTO user_preferences (tenant_id, subject, key, value)
       VALUES ($1, $2, 'connectors', '{"added": ["jira-admin"]}'::jsonb)`,
      [fixture.tenantId, fixture.subject]
    );
    await client.query(
      `INSERT INTO connector_configs (tenant_id, connector, enabled, encrypted_secrets, settings)
       VALUES ($1, 'atlassian-admin', true, 'not-a-real-secret', '{}'::jsonb)`,
      [fixture.tenantId]
    );
    // Connected, with sealed tokens far from expiry so nothing refreshes.
    await client.query(
      `INSERT INTO provider_grants
         (tenant_id, provider, provider_account_id, subject, client_id, display_name,
          encrypted_access_token, encrypted_refresh_token, expires_at, requested_scopes,
          metadata)
       VALUES ($1, 'atlassian-admin', 'e2e-jira-admin-account', $2, 'e2e-admin-client',
               'E2E Jira Admin', $3, $4, $5, $6, $7)`,
      [
        fixture.tenantId,
        fixture.subject,
        secretbox('e2e-admin-access-token'),
        secretbox('e2e-admin-refresh-token'),
        new Date(Date.now() + 365 * 24 * 3_600_000),
        [...FULL_SCOPES, 'offline_access'],
        { cloudId: fixture.cloudId, siteUrl: 'https://e2e.atlassian.net' },
      ]
    );
  });
}

interface Proposal {
  title: string;
  operations: unknown[];
  global?: boolean;
  subject?: string;
  cloudId?: string;
  expired?: boolean;
  reason?: string;
}

/** The row jira_admin_propose_option_changes writes. */
async function propose(fixture: Fixture, proposal: Proposal): Promise<string> {
  const payload = {
    field: { id: FIELD_ID, name: 'Source', type: 'select list (single choice)' },
    context: {
      id: CONTEXT_ID,
      name: proposal.global ? 'Default Configuration Scheme for Source' : 'Ops context',
      global: proposal.global ?? false,
      spaces: proposal.global ? [] : ['OPS'],
    },
    parent: null,
    operations: proposal.operations,
  };
  const result = await withDb((client) =>
    client.query<{ id: string }>(
      `INSERT INTO jira_admin_change_requests
         (tenant_id, subject, cloud_id, site_url, kind, title, reason, payload, expires_at)
       VALUES ($1, $2, $3, 'https://e2e.atlassian.net', 'field_options', $4, $5, $6, $7)
       RETURNING id`,
      [
        fixture.tenantId,
        proposal.subject ?? fixture.subject,
        proposal.cloudId ?? fixture.cloudId,
        proposal.title,
        proposal.reason ?? null,
        JSON.stringify(payload),
        new Date(Date.now() + (proposal.expired ? -60_000 : 24 * 3_600_000)),
      ]
    )
  );
  const id = result.rows[0]?.id;
  if (!id) throw new Error('no change request inserted');
  return id;
}

async function statusOf(id: string): Promise<string | undefined> {
  const result = await withDb((client) =>
    client.query<{ status: string }>(
      'SELECT status FROM jira_admin_change_requests WHERE id = $1',
      [id]
    )
  );
  return result.rows[0]?.status;
}

/** What the stand-in Jira holds for the field's context now. */
async function liveOptions(fixture: Fixture): Promise<string[]> {
  const response = await fetch(
    `${STUB}/${fixture.cloudId}/rest/api/3/field/${FIELD_ID}/context/${CONTEXT_ID}/option`
  );
  const body: unknown = await response.json();
  const values: unknown[] =
    typeof body === 'object' && body !== null && 'values' in body && Array.isArray(body.values)
      ? body.values
      : [];
  return values.map((option) => {
    const record: Record<string, unknown> =
      typeof option === 'object' && option !== null
        ? Object.fromEntries(Object.entries(option))
        : {};
    return `${String(record.value)}${record.disabled === true ? ' (disabled)' : ''}`;
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

/**
 * The page's own content. Test ids are looked up inside it: right after a
 * full load, React can still hold a hidden copy of a streamed segment
 * outside <main> (role queries skip hidden nodes; test ids do not).
 */
function main(page: Page) {
  return page.getByRole('main');
}

async function noHorizontalOverflow(page: Page): Promise<void> {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth
  );
  expect(overflow).toBeLessThanOrEqual(0);
}

test.describe.configure({ mode: 'serial' });

test('a proposal waits for review, and applying it changes Jira exactly as shown', async ({
  page,
}, testInfo) => {
  const fixture = fixtureFor(testInfo.project.name);
  await seedTenant(fixture);
  await signIn(page, fixture);

  // --- Nothing proposed yet. ---
  await page.goto(`/${fixture.slug}/jira-admin/changes`);
  await expect(page.getByRole('heading', { name: 'Jira admin changes', level: 1 })).toBeVisible();
  await expect(main(page).getByText('Nothing to review.')).toBeVisible();
  await shot(page, testInfo, 'jira-admin-changes-01-empty');

  // --- A proposal arrives (as the propose tool writes it). ---
  const title =
    'Source (Ops context): add option “Vendor”; rename “Partner” to “Channel partner”; ' +
    'disable “Legacy”; move “Vendor” to the top';
  const id = await propose(fixture, {
    title,
    reason: 'Procurement tags vendor tickets from Monday',
    operations: [
      { op: 'add', values: ['Vendor'] },
      { op: 'rename', renames: [{ optionId: '10002', from: 'Partner', to: 'Channel partner' }] },
      { op: 'disable', options: [{ optionId: '10003', value: 'Legacy' }] },
      { op: 'move', options: [{ value: 'Vendor' }], position: 'First' },
    ],
  });

  // The Connectors page says one is waiting, and leads to it.
  await page.goto(`/${fixture.slug}/connectors`);
  const card = page.locator('[data-coach="card-jira-admin"]');
  const waiting = card.getByTestId('jira-admin-changes-link');
  await expect(waiting).toHaveText('1 proposed change waiting for your review');
  // Client-side navigations: on a cold `next dev` a route compiles on its
  // first visit (the review page took ~5s), past the default 5s wait.
  await waiting.click();
  await expect(page).toHaveURL(new RegExp(`/${fixture.slug}/jira-admin/changes$`), {
    timeout: 30_000,
  });
  await page.getByRole('link', { name: new RegExp('Source \\(Ops context\\)') }).click();
  await expect(page).toHaveURL(new RegExp(`/jira-admin/changes/${id}$`), { timeout: 30_000 });

  // --- The review page: every operation, where, why. ---
  await expect(page.getByRole('heading', { name: 'Review a Jira admin change' })).toBeVisible();
  await expect(main(page).getByTestId('change-state')).toHaveText('Waiting for review');
  await expect(main(page).getByTestId('change-reach')).toHaveText(
    'Where: The context “Ops context”, used by OPS.'
  );
  await expect(main(page).getByText('Procurement tags vendor tickets from Monday')).toBeVisible();
  const operations = main(page).getByTestId('change-operations').getByRole('listitem');
  await expect(operations).toHaveText([
    'Add option “Vendor”',
    'Rename “Partner” to “Channel partner”',
    'Disable “Legacy”',
    'Move “Vendor” to the top',
  ]);
  // Nothing has reached Jira yet.
  expect(await liveOptions(fixture)).toEqual(['Customer', 'Partner', 'Legacy']);
  await shot(page, testInfo, 'jira-admin-changes-02-review');

  // --- Apply: the stored operations run, in order, against Jira. ---
  await page.getByRole('button', { name: 'Apply these 4 changes to Jira' }).click();
  await expect(main(page).getByTestId('change-state')).toHaveText('Applied', { timeout: 30_000 });
  await expect(page.getByRole('heading', { name: 'What happened' })).toBeVisible();
  await expect(operations.getByText('Done', { exact: true })).toHaveCount(4);
  await expect(page.getByRole('button', { name: /Apply/ })).toHaveCount(0);
  expect(await liveOptions(fixture)).toEqual([
    'Vendor',
    'Customer',
    'Channel partner',
    'Legacy (disabled)',
  ]);
  expect(await statusOf(id)).toBe('applied');
  // Recorded in the audit trail, on the owner's click.
  await expect
    .poll(async () =>
      withDb(async (client) => {
        const rows = await client.query<{ actor_subject: string; details: { status: string } }>(
          `SELECT actor_subject, details FROM audit_events
            WHERE tenant_id = $1 AND action = 'jira_admin.change_applied'`,
          [fixture.tenantId]
        );
        return rows.rows.map((row) => `${row.actor_subject}:${row.details.status}`);
      })
    )
    .toEqual([`${fixture.subject}:applied`]);
  await shot(page, testInfo, 'jira-admin-changes-03-applied');

  // Applying twice is refused — the route, not only the missing button.
  const again = await page.request.post(
    `/api/tenant/${fixture.tenantId}/jira-admin/changes/${id}/apply`
  );
  expect(again.status()).toBe(409);

  // The list now files it under Recent.
  await page.goto(`/${fixture.slug}/jira-admin/changes`);
  await expect(main(page).getByText('Nothing to review.')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Recent' })).toBeVisible();
  await expect(main(page).getByTestId('change-state')).toHaveText('Applied');

  // Mobile: a resized Chromium viewport, not a device descriptor.
  await page.setViewportSize(MOBILE_VIEWPORT);
  await noHorizontalOverflow(page);
  await page.goto(`/${fixture.slug}/jira-admin/changes/${id}`);
  await expect(main(page).getByTestId('change-title')).toBeVisible();
  await noHorizontalOverflow(page);
  await shot(page, testInfo, 'jira-admin-changes-04-mobile');
});

test('a stale or refused proposal changes nothing, and says why', async ({ page }, testInfo) => {
  const fixture = fixtureFor(testInfo.project.name);
  await seedTenant(fixture);
  await signIn(page, fixture);

  // --- Jira moved underneath: an option this adds exists by now (added by hand since). ---
  const stale = await propose(fixture, {
    title: 'Source (Ops context): disable “Legacy”; add option “Customer”',
    operations: [
      { op: 'disable', options: [{ optionId: '10003', value: 'Legacy' }] },
      { op: 'add', values: ['Customer'] },
      { op: 'rename', renames: [{ optionId: '10002', from: 'Partner', to: 'Reseller' }] },
    ],
  });
  await page.goto(`/${fixture.slug}/jira-admin/changes/${stale}`);
  await page.getByRole('button', { name: 'Apply these 3 changes to Jira' }).click();
  await expect(main(page).getByTestId('change-state')).toHaveText('Partly applied', {
    timeout: 30_000,
  });
  const results = main(page).getByTestId('change-operations').getByRole('listitem');
  await expect(results.nth(0)).toContainText('Done');
  await expect(results.nth(1)).toContainText('Failed');
  await expect(results.nth(1)).toContainText('“Customer” already exists.');
  await expect(results.nth(2)).toContainText('Not run');
  // The disable ran; the rename after the failure did not.
  expect(await liveOptions(fixture)).toEqual(['Customer', 'Partner', 'Legacy (disabled)']);
  await shot(page, testInfo, 'jira-admin-changes-05-partial');

  // --- Proposed against another Jira site: refused, still pending. ---
  const elsewhere = await propose(fixture, {
    title: 'Source (Ops context): add option “Vendor”',
    cloudId: 'some-other-site',
    operations: [{ op: 'add', values: ['Vendor'] }],
  });
  await page.goto(`/${fixture.slug}/jira-admin/changes/${elsewhere}`);
  await page.getByRole('button', { name: 'Apply this change to Jira' }).click();
  // Filtered: Next's route announcer is a role="alert" too.
  await expect(page.getByRole('alert').filter({ hasText: /different Jira site/ })).toBeVisible();
  await expect(main(page).getByTestId('change-state')).toHaveText('Waiting for review');
  expect(await statusOf(elsewhere)).toBe('pending');

  // --- A global context is called out before anyone applies it. ---
  const global = await propose(fixture, {
    title: 'Source (global context): add option “Vendor”',
    global: true,
    operations: [{ op: 'add', values: ['Vendor'] }],
  });
  await page.goto(`/${fixture.slug}/jira-admin/changes/${global}`);
  await expect(main(page).getByTestId('change-reach')).toContainText(
    'it reaches every space that has no context of its own'
  );
  await shot(page, testInfo, 'jira-admin-changes-06-global');

  // --- The connection lost the scope the writes need: Apply is off, and says why. ---
  await withDb((client) =>
    client.query(
      `UPDATE provider_grants SET requested_scopes = $2
        WHERE tenant_id = $1 AND provider = 'atlassian-admin'`,
      [fixture.tenantId, ['read:jira-user', 'read:jira-work', 'offline_access']]
    )
  );
  await page.reload();
  await expect(main(page).getByText(/does not include manage:jira-configuration/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Apply this change to Jira' })).toBeDisabled();
  const refused = await page.request.post(
    `/api/tenant/${fixture.tenantId}/jira-admin/changes/${global}/apply`
  );
  expect(refused.status()).toBe(403);
  expect(await statusOf(global)).toBe('pending');
  await shot(page, testInfo, 'jira-admin-changes-07-refused');

  // --- Cancel withdraws it. ---
  await page.getByRole('button', { name: 'Cancel it' }).click();
  await expect(main(page).getByTestId('change-state')).toHaveText('Cancelled', { timeout: 30_000 });
  await expect(page.getByRole('button', { name: 'Cancel it' })).toHaveCount(0);
  expect(await statusOf(global)).toBe('cancelled');

  // --- Expired: shown as such, and the route refuses it. ---
  const expired = await propose(fixture, {
    title: 'Source (Ops context): add option “Vendor”',
    expired: true,
    operations: [{ op: 'add', values: ['Vendor'] }],
  });
  await page.goto(`/${fixture.slug}/jira-admin/changes/${expired}`);
  await expect(main(page).getByTestId('change-state')).toHaveText('Expired');
  await expect(page.getByRole('button', { name: /Apply/ })).toHaveCount(0);
  const late = await page.request.post(
    `/api/tenant/${fixture.tenantId}/jira-admin/changes/${expired}/apply`
  );
  expect(late.status()).toBe(409);

  // --- Someone else's: not found, on the page and at the route. ---
  const theirs = await propose(fixture, {
    title: 'Source (Ops context): add option “Vendor”',
    subject: 'someone-else@example.com',
    operations: [{ op: 'add', values: ['Vendor'] }],
  });
  // The page streams behind the tenant layout's loading state, so its
  // not-found arrives as content rather than a 404 status — assert on that.
  await page.goto(`/${fixture.slug}/jira-admin/changes/${theirs}`);
  await expect(page.getByRole('heading', { name: 'This page could not be found.' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Review a Jira admin change' })).toHaveCount(0);
  const notYours = await page.request.post(
    `/api/tenant/${fixture.tenantId}/jira-admin/changes/${theirs}/apply`
  );
  expect(notYours.status()).toBe(404);
  expect(await statusOf(theirs)).toBe('pending');

  // Nothing any refusal touched reached Jira.
  expect(await liveOptions(fixture)).toEqual(['Customer', 'Partner', 'Legacy (disabled)']);
});

test('an agent’s proposal can page its owner: Jira Administration has its own notification group', async ({
  page,
}, testInfo) => {
  const fixture = fixtureFor(testInfo.project.name);
  await seedTenant(fixture);
  await signIn(page, fixture);

  await page.goto(`/${fixture.slug}/preferences`);
  const notifications = page.getByRole('region', { name: 'Notifications' });
  const summary = notifications.locator('summary').filter({ hasText: 'Jira Administration' });
  await expect(summary).toHaveCount(1);
  await summary.click();
  // A proposal files under "Creates something"; its switch is its own,
  // apart from everyday Jira's.
  await expect(
    notifications.getByRole('checkbox', { name: 'Jira Administration Creates something — App' })
  ).toBeVisible();
  await shot(page, testInfo, 'jira-admin-changes-08-notifications');

  await page.setViewportSize(MOBILE_VIEWPORT);
  await expect(
    notifications.getByRole('checkbox', { name: 'Jira Administration Creates something — App' })
  ).toBeVisible();
  await noHorizontalOverflow(page);
});
