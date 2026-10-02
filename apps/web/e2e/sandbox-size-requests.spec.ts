/**
 * The code-workspace checkout size limit, end to end in a browser: an
 * admin sets the org limit from Settings (default 8 GB); a member of a
 * code project asks for a larger checkout with a reason; the admin sees
 * the request and approves it (raising that project only) or denies it
 * with a note, and the project page reflects each outcome. The sandbox
 * worker is the stub in sandbox-stub.mjs, so the project's checkout is
 * "ready" without any network.
 *
 * Each Playwright project gets its own tenant, derived from the project
 * name (the llm-models.spec.ts pattern): this spec writes settings and
 * requests, and projects run concurrently against one dev database.
 *
 * Mobile is a resized Chromium viewport, not the `mobile` project's device
 * descriptor (AGENTS.md, "UI changes"). Screenshots land under
 * test-results/screens/<project>/size-requests-*.png.
 */

import { createHash } from 'node:crypto';
import path from 'node:path';
import { test, expect as baseExpect, type Page, type TestInfo } from '@playwright/test';
import { Client } from 'pg';

const RESULTS = path.join(import.meta.dirname, '..', 'test-results');
const MOBILE_VIEWPORT = { width: 390, height: 844 };
const GB = 1_073_741_824;

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
    tenantId: uuidFrom(`size-requests-e2e-tenant:${projectName}`),
    sessionId: uuidFrom(`size-requests-e2e-session:${projectName}`),
    projectId: uuidFrom(`size-requests-e2e-project:${projectName}`),
    slug: `e2e-size-requests-${projectName}`,
    subject: `e2e-size-requests-${projectName}@example.com`,
    projectName: `Monorepo (${projectName})`,
  };
}
type Fixture = ReturnType<typeof fixtureFor>;

async function seed(fixture: Fixture): Promise<void> {
  const worker = process.env.SANDBOX_WORKER_URL ?? 'http://127.0.0.1:8092';
  const headers = {
    authorization: `Bearer ${process.env.SANDBOX_WORKER_API_KEY ?? 'e2e-sandbox-key'}`,
    'content-type': 'application/json',
  };
  const target = { tenantId: fixture.tenantId, subject: `code-project:${fixture.projectId}` };
  const cloned = await fetch(`${worker}/v1/workspaces/clone`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      ...target,
      provider: 'atlassian-bitbucket',
      repoFullName: 'acme/monorepo',
      branch: 'main',
      cloneUrl: 'https://bitbucket.org/acme/monorepo.git',
      gitProxy: {
        base: 'http://127.0.0.1:8096/git/e2e/bitbucket.org/',
        insteadOf: 'https://bitbucket.org/',
      },
    }),
  });
  const { workspace }: { workspace: { id: string } } = await cloned.json();
  for (let tries = 0; tries < 20; tries += 1) {
    const got = await fetch(`${worker}/v1/workspaces/get`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ ...target, id: workspace.id }),
    });
    const state: { workspace: { status: string } } = await got.json();
    if (state.workspace.status === 'ready') break;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    const t = fixture.tenantId;
    await client.query('DELETE FROM sandbox_size_requests WHERE tenant_id = $1', [t]);
    await client.query('DELETE FROM tenant_settings WHERE tenant_id = $1', [t]);
    await client.query('DELETE FROM chat_projects WHERE tenant_id = $1', [t]);
    await client.query('DELETE FROM sessions WHERE tenant_id = $1', [t]);
    await client.query('DELETE FROM identities WHERE tenant_id = $1', [t]);
    await client.query('DELETE FROM tenants WHERE id = $1', [t]);
    await client.query('INSERT INTO tenants (id, slug) VALUES ($1, $2)', [t, fixture.slug]);
    await client.query(
      `INSERT INTO sessions (id, tenant_id, subject, roles, expires_at) VALUES ($1, $2, $3, $4, $5)`,
      [
        fixture.sessionId,
        t,
        fixture.subject,
        ['renkei-user', 'renkei-operator'],
        new Date(Date.now() + 24 * 3_600_000),
      ]
    );
    await client.query(
      `INSERT INTO identities (tenant_id, subject, email, display_name) VALUES ($1, $2, $3, 'E2E Tester')`,
      [t, fixture.subject, fixture.subject]
    );
    await client.query(
      `INSERT INTO user_preferences (tenant_id, subject, key, value)
       VALUES ($1, $2, 'coach_marks', '{"autoStart": false}'::jsonb)`,
      [t, fixture.subject]
    );
    await client.query(
      `INSERT INTO chat_projects
         (id, tenant_id, owner_subject, name, kind, repo_provider, repo_full_name, repo_branch, workspace_id)
       VALUES ($1, $2, $3, $4, 'code', 'atlassian-bitbucket', 'acme/monorepo', 'main', $5)`,
      [fixture.projectId, t, fixture.subject, fixture.projectName, workspace.id]
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
    path: path.join(RESULTS, 'screens', testInfo.project.name, `size-requests-${name}.png`),
    fullPage: true,
  });
}

async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  const expect = baseExpect;
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth
  );
  expect(overflow).toBeLessThanOrEqual(0);
}

async function dbRows<T extends Record<string, unknown>>(
  sql: string,
  params: unknown[]
): Promise<T[]> {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    return (await client.query<T>(sql, params)).rows;
  } finally {
    await client.end();
  }
}

test('checkout limit: org setting, request, approve, deny', async ({ page }, testInfo) => {
  // The dev server compiles each route on its first hit, which outlasts the default 5s.
  test.setTimeout(240_000);
  const expect = baseExpect.configure({ timeout: 30_000 });
  const fixture = fixtureFor(testInfo.project.name);
  await seed(fixture);
  await signIn(page, fixture);
  const projectUrl = `/${fixture.slug}/code/${fixture.projectId}`;
  const settingsUrl = `/${fixture.slug}/admin/settings`;
  // Scoped to the main region: across a navigation the dev server can leave
  // the outgoing page's span in the DOM for a beat, and strict mode would
  // count two.
  const limitText = page.getByRole('main').getByTestId('size-limit');

  // ── Default: 8 GB, with the way to ask for more ──
  await page.goto(projectUrl);
  await expect(limitText).toHaveText('Checkout limit 8 GB.');
  await expect(page.getByTestId('size-request-pending')).toHaveCount(0);
  await shot(page, testInfo, '01-project-default');

  // ── A member asks for more: the form needs a reason; a second ask waits ──
  // The ask is a link, not a form on the page: nothing to fill until it is opened.
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByLabel('Size wanted (GB)')).toHaveCount(0);
  await page.getByRole('button', { name: 'Ask for more space' }).click();
  const dialog = page.getByRole('dialog', { name: 'Ask for more space' });
  await expect(dialog).toBeVisible();
  await page.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toHaveCount(0);
  await page.getByRole('button', { name: 'Ask for more space' }).click();
  await expect(page.getByLabel('Size wanted (GB)')).toHaveValue('16');
  const send = page.getByRole('button', { name: 'Send request' });
  await expect(send).toBeDisabled();
  await page.getByLabel('Size wanted (GB)').fill('24');
  await page.getByLabel('Why you need it').fill('Monorepo with vendored toolchains');
  await shot(page, testInfo, '03-request-form');
  await send.click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByTestId('size-request-pending')).toHaveText(
    'Your request for 24 GB is waiting for an admin.'
  );
  await expect(page.getByRole('button', { name: 'Ask for more space' })).toHaveCount(0);
  await shot(page, testInfo, '04-request-pending');

  // The server refuses a duplicate and a request at or under the limit.
  const api = `/api/tenant/${fixture.tenantId}/code/projects/${fixture.projectId}/size-request`;
  const duplicate = await page.request.post(api, {
    data: { requestedBytes: 30 * GB, reason: 'again' },
  });
  expect(duplicate.status()).toBe(409);

  // ── The admin approves less than was asked; the limit rises for the project ──
  await page.goto(settingsUrl);
  const rows = page.getByTestId('size-request-row');
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText(fixture.projectName);
  await expect(rows.first()).toContainText('24 GB');
  await expect(rows.first()).toContainText('Monorepo with vendored toolchains');
  await shot(page, testInfo, '05-admin-pending');
  await rows.first().getByLabel('Approve up to (GB)').fill('20');
  await rows.first().getByRole('button', { name: 'Approve' }).click();
  await expect(page.getByText('No requests waiting.')).toBeVisible();
  await expect(page.getByTestId('size-requests')).toContainText('20 GB approved');

  await page.goto(projectUrl);
  await expect(limitText).toHaveText('Checkout limit 20 GB.');
  await expect(page.getByTestId('size-request-last')).toContainText(
    'Your request for 20 GB was approved.'
  );
  await shot(page, testInfo, '06-project-approved');

  // ── A further ask is denied with a note; the limit stays ──
  await page.getByRole('button', { name: 'Ask for more space' }).click();
  await page.getByLabel('Size wanted (GB)').fill('40');
  await page.getByLabel('Why you need it').fill('Want it all');
  await page.getByRole('button', { name: 'Send request' }).click();
  await expect(page.getByTestId('size-request-pending')).toBeVisible();

  await page.goto(settingsUrl);
  await page.getByTestId('size-request-row').getByLabel('Note').fill('Prune build output first');
  await page.getByTestId('size-request-row').getByRole('button', { name: 'Deny' }).click();
  await expect(page.getByText('No requests waiting.')).toBeVisible();

  await page.goto(projectUrl);
  await expect(limitText).toHaveText('Checkout limit 20 GB.');
  await expect(page.getByTestId('size-request-last')).toContainText(
    'Your last request was denied: Prune build output first'
  );
  await shot(page, testInfo, '07-project-denied');

  // ── An admin changes the org limit from Settings ──
  // Saved and stored at once; the pages read it through the org settings'
  // 60-second cache, which this spec deliberately does not wait out.
  await page.goto(settingsUrl);
  const orgLimit = page.getByLabel('sandboxWorkspaceMaxGb');
  await expect(orgLimit).toHaveValue('8');
  await orgLimit.fill('12');
  await page.getByRole('button', { name: 'Save settings' }).click();
  await expect(page.getByText('Saved.')).toBeVisible();
  const stored = await dbRows<{ value: string }>(
    `SELECT value FROM tenant_settings WHERE tenant_id = $1 AND key = 'sandbox_workspace_max_bytes'`,
    [fixture.tenantId]
  );
  expect(Number(stored[0]?.value)).toBe(12 * GB);
  const read = await page.request.get(`/api/admin/${fixture.slug}/org-settings`);
  expect((await read.json()).settings.sandboxWorkspaceMaxBytes).toBe(12 * GB);
  // Out of range is clamped, never stored as typed.
  const clamped = await page.request.put(`/api/admin/${fixture.slug}/org-settings`, {
    data: { sandboxWorkspaceMaxBytes: 500 * GB },
  });
  expect((await clamped.json()).settings.sandboxWorkspaceMaxBytes).toBe(64 * GB);
  await page.request.put(`/api/admin/${fixture.slug}/org-settings`, {
    data: { sandboxWorkspaceMaxBytes: 12 * GB },
  });
  await shot(page, testInfo, '08-settings-org-limit');

  // ── Phone width: both pages hold their layout ──
  await page.setViewportSize(MOBILE_VIEWPORT);
  await page.goto(projectUrl);
  await page.getByRole('button', { name: 'Ask for more space' }).click();
  await expect(page.getByRole('button', { name: 'Send request' })).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await shot(page, testInfo, '09-project-mobile');
  await page.goto(settingsUrl);
  await expect(page.getByLabel('sandboxWorkspaceMaxGb')).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await shot(page, testInfo, '10-settings-mobile');
});
