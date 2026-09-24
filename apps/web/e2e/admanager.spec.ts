/**
 * The ADManager Plus connector, end to end in a browser: the admin's
 * instance registry (empty state, create, a reachability test, manage/
 * edit, delete) and the user's connect flow on the connectors page (an
 * already-connected card's real, persisted permission changes and
 * disconnect, plus the fail-closed message when the service isn't wired
 * up).
 *
 * This e2e environment runs no apps/worker-admanager and sets neither
 * ADMANAGER_WORKER_URL nor ADMANAGER_WORKER_API_KEY (playwright.config.ts's
 * webServer only passes through DATABASE_URL/TOKEN_ENCRYPTION_KEY/
 * LOG_ENCRYPTION_KEY plus the Bitbucket/Jira stub URLs) — so
 * `admanagerWorkerConfigured()` is really false here, the same as a
 * deployment that hasn't stood the worker up yet. Rather than mocking a
 * vendor round trip that never gets this far, the "test reachability" and
 * "connect with an authtoken" flows are exercised against that REAL,
 * unmocked "service not configured" answer (see
 * docs/admanager-connector-design.md: "a missing pair means every
 * operation answers 'unconfigured' — never open"), which is itself a code
 * path worth proving. What CAN be exercised for real without a worker —
 * because neither route calls it — is the permission grid (an
 * already-connected row's permission-only POST) and disconnect, both
 * seeded and re-verified straight against the dev database.
 *
 * Own tenant per test (AGENTS.md's rule for a spec that writes data):
 * projects run concurrently against the same dev Postgres, and the
 * user-connect test needs its own pre-seeded admanager_instances /
 * admanager_instance_connections rows that must not collide with the
 * admin test's UI-created ones.
 *
 * Runs on the pinned Chromium only (no WebKit installed in this sandbox —
 * see voice.spec.ts's note); "mobile" is a resized viewport rather than
 * the `mobile` project's device descriptor, per AGENTS.md.
 */

import { createCipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import path from 'node:path';
import { test, expect, type Page, type TestInfo } from '@playwright/test';
import { Client } from 'pg';

const RESULTS = path.join(import.meta.dirname, '..', 'test-results');
const MOBILE_VIEWPORT = { width: 390, height: 844 };
const UNCONFIGURED_MESSAGE = 'The ADManager Plus service is not configured on this deployment';

test.use({
  launchOptions: {
    executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    args: ['--no-sandbox'],
  },
});

/**
 * `@renkei/crypto`'s secretbox, reproduced: `v1.<iv>.<tag>.<ciphertext>`
 * (aes-256-gcm, base64 parts) under TOKEN_ENCRYPTION_KEY — what
 * `encryptCredentials` (packages/connector-admanager/src/credentials.ts)
 * would have sealed for a real connect, so a seeded connection row is
 * indistinguishable from one made through the UI. See code.spec.ts's own
 * copy of this helper for the same reasoning (a Playwright spec imports
 * `pg` and node builtins, not the app's server-only packages).
 */
function secretbox(plaintext: string): string {
  const encoded = process.env.TOKEN_ENCRYPTION_KEY;
  if (!encoded) throw new Error('TOKEN_ENCRYPTION_KEY is not set');
  const key = Buffer.from(encoded, 'base64');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return [
    'v1',
    iv.toString('base64'),
    cipher.getAuthTag().toString('base64'),
    ciphertext.toString('base64'),
  ].join('.');
}

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
    tenantId: uuidFrom(`admanager-e2e-tenant:${projectName}`),
    sessionId: uuidFrom(`admanager-e2e-session:${projectName}`),
    slug: `e2e-admanager-${projectName}`,
    subject: `e2e-admanager-${projectName}@example.com`,
  };
}

type Fixture = ReturnType<typeof fixtureFor>;

async function baseSeed(client: Client, fixture: Fixture): Promise<void> {
  await client.query('DELETE FROM admanager_instance_connections WHERE tenant_id = $1', [
    fixture.tenantId,
  ]);
  await client.query('DELETE FROM admanager_instances WHERE tenant_id = $1', [fixture.tenantId]);
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
}

async function seedAdminTenant(fixture: Fixture): Promise<void> {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    await baseSeed(client, fixture);
  } finally {
    await client.end();
  }
}

/**
 * The user-connect test's fixture: one registered instance, already
 * connected (a real sealed authtoken, a technician name, read-only
 * permissions) — exactly what a completed connect flow would have
 * written — plus the connectors-page preference that offers its card.
 */
async function seedUserTenant(fixture: Fixture): Promise<{ instanceId: string }> {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    await baseSeed(client, fixture);
    const instanceId = randomUUID();
    await client.query(
      `INSERT INTO admanager_instances (id, tenant_id, name, environment, base_url, enabled)
       VALUES ($1, $2, $3, $4, $5, true)`,
      [instanceId, fixture.tenantId, 'ADManager Plus prod', 'prod', 'https://admp.example.com:8080']
    );
    await client.query(
      `INSERT INTO admanager_instance_connections
         (tenant_id, instance_id, subject, encrypted_credentials, technician_name, permissions)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        fixture.tenantId,
        instanceId,
        fixture.subject,
        secretbox(JSON.stringify({ authToken: 'e2e-seeded-authtoken' })),
        'Jamie Lee',
        ['accounts.read'],
      ]
    );
    await client.query(
      `INSERT INTO user_preferences (tenant_id, subject, key, value)
       VALUES ($1, $2, 'connectors', '{"added": ["admanager"]}'::jsonb)`,
      [fixture.tenantId, fixture.subject]
    );
    return { instanceId };
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

test('admin: ADManager Plus instance registry — create, reachability, edit, delete', async ({
  page,
}, testInfo) => {
  const fixture = fixtureFor(testInfo.project.name);
  await seedAdminTenant(fixture);
  await signIn(page, fixture);

  await page.goto(`/${fixture.slug}/admin/admanager`);
  await expect(page.getByRole('heading', { name: 'ADManager Plus', exact: true })).toBeVisible();
  await expect(page.getByText('No instances registered yet.')).toBeVisible();
  await shot(page, testInfo, 'admanager-admin-01-empty');

  await page.getByRole('button', { name: '+ New instance' }).click();
  await page.getByLabel('Name').fill('ADManager Plus prod');
  await page.getByLabel('Environment').fill('prod');
  await page.getByLabel('Server URL').fill('https://admp.example.com:8080');
  // The reset-password template is an instance setting (the REST API
  // cannot set "must change password at next logon" itself, so the tools
  // apply this template after a reset — see the design doc).
  await page
    .getByLabel('Reset-password template (optional)')
    .fill('Reset Password – must change at next logon');
  await shot(page, testInfo, 'admanager-admin-02-draft-filled');

  // No worker is configured in this environment (see the file header) —
  // the real, unmocked answer is "not configured", the fail-closed
  // behavior the design doc describes.
  await page.getByRole('button', { name: 'Test reachability' }).click();
  await expect(page.getByText(UNCONFIGURED_MESSAGE)).toBeVisible();
  await shot(page, testInfo, 'admanager-admin-03-unconfigured');

  // The instance registry CRUD itself calls no worker — real create route,
  // real DB.
  await page.getByRole('button', { name: 'Create instance' }).click();
  await expect(page.getByText('ADManager Plus prod')).toBeVisible();
  await shot(page, testInfo, 'admanager-admin-04-created');

  await page.getByRole('link', { name: 'Manage', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'ADManager Plus prod' })).toBeVisible();
  await expect(page.getByLabel('Server URL')).toHaveValue('https://admp.example.com:8080');
  // The template survived create → stored settings JSON → GET.
  await expect(page.getByLabel('Reset-password template (optional)')).toHaveValue(
    'Reset Password – must change at next logon'
  );

  // Edit and save through the real PATCH route — the template changes too.
  await page.getByLabel('Environment').fill('staging');
  await page.getByLabel('Reset-password template (optional)').fill('Helpdesk Reset Template');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Saved.')).toBeVisible();
  await shot(page, testInfo, 'admanager-admin-05-edited');

  // Reload and re-read from the real database: the PATCH merged the new
  // template into the stored settings.
  await page.reload();
  await expect(page.getByLabel('Environment')).toHaveValue('staging');
  await expect(page.getByLabel('Reset-password template (optional)')).toHaveValue(
    'Helpdesk Reset Template'
  );

  // Clearing the field clears the stored template (blank → null → key removed).
  await page.getByLabel('Reset-password template (optional)').fill('');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Saved.')).toBeVisible();
  await page.reload();
  await expect(page.getByLabel('Reset-password template (optional)')).toHaveValue('');

  // Mobile: a resized Chromium viewport, not a device descriptor — see
  // AGENTS.md and llm-models.spec.ts's note on why.
  await page.setViewportSize(MOBILE_VIEWPORT);
  await expect(page.getByRole('button', { name: 'Delete instance' })).toBeVisible();
  await shot(page, testInfo, 'admanager-admin-06-mobile-detail');

  // Delete, through the real DELETE route, back to the empty state.
  page.once('dialog', (dialog) => void dialog.accept());
  await page.getByRole('button', { name: 'Delete instance' }).click();
  await expect(page).toHaveURL(new RegExp(`/${fixture.slug}/admin/admanager$`));
  await expect(page.getByText('No instances registered yet.')).toBeVisible();
});

test('user: an already-connected ADManager Plus card — real permission persistence, disconnect, and the fail-closed reconnect message', async ({
  page,
}, testInfo) => {
  const fixture = fixtureFor(`${testInfo.project.name}-user`);
  await seedUserTenant(fixture);
  await signIn(page, fixture);

  await page.goto(`/${fixture.slug}/connectors`);
  await expect(page.getByRole('heading', { name: 'Connectors' })).toBeVisible();
  const card = page.locator('[data-coach="card-admanager"]');
  await expect(card.getByRole('heading', { name: 'ADManager Plus' })).toBeVisible();
  await expect(card.getByText('ADManager Plus prod')).toBeVisible();
  await expect(card.getByText('Connected as')).toBeVisible();
  await expect(card.getByText('Jamie Lee')).toBeVisible();
  await expect(card.getByText(/LLM tools: Read only/)).toBeVisible();
  await shot(page, testInfo, 'admanager-user-01-connected');

  // The permission grid: a preset click is a real, UNMOCKED POST (this
  // path — no credential fields in the body — never touches the worker,
  // see connection/route.ts's carriesCredential check) that persists.
  // The UI updates optimistically before the request resolves, so the
  // reload below must wait for the real response rather than race it.
  await card.getByRole('button', { name: 'Change permissions' }).click();
  const permissionsSaved = page.waitForResponse(
    (response) => response.url().includes('/admanager/') && response.request().method() === 'POST'
  );
  await card.getByRole('button', { name: 'Helpdesk' }).click();
  await expect(card.getByText(/LLM tools: Helpdesk/)).toBeVisible();
  await permissionsSaved;
  await shot(page, testInfo, 'admanager-user-02-permissions');

  // Reload and re-read from the real database: the change actually saved.
  await page.reload();
  await expect(card.getByText(/LLM tools: Helpdesk/)).toBeVisible();

  // Disconnect: also no worker call (deleteConnection is a plain DB
  // delete) — confirm dialog, then the real DELETE route.
  page.once('dialog', (dialog) => void dialog.accept());
  await card.getByRole('button', { name: 'Disconnect' }).click();
  await expect(card.getByRole('button', { name: 'Connect' })).toBeVisible();
  await shot(page, testInfo, 'admanager-user-03-disconnected');

  // Reconnecting for real DOES cross to the worker (test-connection must
  // validate the authtoken against the live server before anything is
  // stored) — with none configured here, the real, unmocked answer is the
  // same fail-closed message the admin probe hit above.
  await card.getByRole('button', { name: 'Connect' }).click();
  await card.getByLabel('Your name (for display)').fill('Jamie Lee');
  await card.getByLabel('Authtoken').fill('e2e-fake-authtoken');
  await card.getByRole('button', { name: 'Connect' }).click();
  await expect(card.getByText(UNCONFIGURED_MESSAGE)).toBeVisible();
  await shot(page, testInfo, 'admanager-user-04-reconnect-unconfigured');

  // Mobile.
  await page.setViewportSize(MOBILE_VIEWPORT);
  await expect(card).toBeVisible();
  await shot(page, testInfo, 'admanager-user-05-mobile');
});
