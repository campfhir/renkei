/**
 * A `needsApproval` card whose gated tool is `jira_create_issue`/
 * `jira_update_issue` hosts the real issue-preview MCP Apps widget
 * (ApprovalWidgetCard) instead of the plain arg list — the same bundle
 * chat's `jira_create_issue_preview` uses, reused outside chat per
 * approval-widget-card.tsx's header comment.
 *
 * Drives the actual iframe: its Summary field is edited and its Create
 * button is clicked, which POSTs an approve decision (with that edit as an
 * argsOverride) to the real decision route — the real DB row is asserted
 * on afterward, not mocked. A second test drives the widget's OWN Cancel
 * button (relabeled "Decline" for this card, per approval-preview.ts's
 * `cancelTool`/`cancelLabel`) and checks it — not a separate external
 * control — is what records the decline; ApprovalActions never renders at
 * all for a widget-hosted card.
 *
 * Its own tenant, agent and run (AGENTS.md's "isolate what you create"):
 * `actionable_items.run_id` is a real FK to `agent_runs`, so this seeds
 * just enough of an agent/run to satisfy it — no worker process ever
 * touches them in this test, only the decision route and the page render.
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

function fixtureFor(name: string): {
  tenantId: string;
  sessionId: string;
  agentId: string;
  runId: string;
  itemId: string;
  slug: string;
  subject: string;
} {
  return {
    tenantId: uuidFrom(`approval-widget-e2e-tenant:${name}`),
    sessionId: uuidFrom(`approval-widget-e2e-session:${name}`),
    agentId: uuidFrom(`approval-widget-e2e-agent:${name}`),
    runId: uuidFrom(`approval-widget-e2e-run:${name}`),
    itemId: uuidFrom(`approval-widget-e2e-item:${name}`),
    slug: `e2e-approval-widget-${name}`,
    subject: `e2e-approval-widget-${name}@example.com`,
  };
}

async function seedTenant(client: Client, fixture: ReturnType<typeof fixtureFor>): Promise<void> {
  // A prior run's decision really did enqueue a resume job (decideApproval
  // is the real thing, not mocked) — clean it up before the tenant, or the
  // FK on agent_jobs blocks the delete.
  await client.query('DELETE FROM agent_jobs WHERE tenant_id = $1', [fixture.tenantId]);
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
  await client.query(
    `INSERT INTO user_preferences (tenant_id, subject, key, value)
     VALUES ($1, $2, 'coach_marks', '{"autoStart": false}'::jsonb)`,
    [fixture.tenantId, fixture.subject]
  );
  await client.query(
    `INSERT INTO agents (id, tenant_id, owner_subject, name, description_status, steps, enabled)
     VALUES ($1, $2, $3, 'Portfolio Updater', 'ready', '{"version":1,"steps":[]}'::jsonb, true)`,
    [fixture.agentId, fixture.tenantId, fixture.subject]
  );
  await client.query(
    `INSERT INTO agent_runs
       (id, tenant_id, agent_id, owner_subject, trigger_kind, steps_snapshot, status, started_at, created_at)
     VALUES ($1, $2, $3, $4, 'manual', '{"version":1,"steps":[]}'::jsonb, 'waiting', NOW(), NOW())`,
    [fixture.runId, fixture.tenantId, fixture.agentId, fixture.subject]
  );
}

async function seedCard(
  client: Client,
  fixture: ReturnType<typeof fixtureFor>,
  suggestedAction: unknown
): Promise<void> {
  await client.query('DELETE FROM actionable_items WHERE id = $1', [fixture.itemId]);
  await client.query(
    `INSERT INTO actionable_items
       (id, tenant_id, source, kind, status, title, summary, evidence, suggested_action,
        owner_subject, created_by, created_by_agent_id, run_id)
     VALUES ($1, $2, 'agents', 'approval', 'suggested', $3, 'Wants to call Create issue.',
             '{}'::jsonb, $4::jsonb, $5, $5, $6, $7)`,
    [
      fixture.itemId,
      fixture.tenantId,
      'Portfolio Updater — Create the approved issue',
      JSON.stringify(suggestedAction),
      fixture.subject,
      fixture.agentId,
      fixture.runId,
    ]
  );
}

async function signIn(page: Page, fixture: ReturnType<typeof fixtureFor>): Promise<void> {
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

test('confirming an edit on the widget approves the card with that edit as an argsOverride', async ({
  page,
}, testInfo) => {
  const fixture = fixtureFor(`confirm-${testInfo.project.name}`);
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    await seedTenant(client, fixture);
    await seedCard(client, fixture, {
      tool: 'jira_create_issue',
      args: {
        projectKey: 'CIO',
        issueType: 'Project',
        summary: 'Salesforce Incentive-Program Tracking',
        fields: { 'Anti-Kickback Review': 'Required' },
      },
    });
    await signIn(page, fixture);

    await page.goto(`/${fixture.slug}`);
    const widgetFrame = page.frameLocator('iframe[title="Approval preview"]');
    await expect(widgetFrame.getByText('Create Jira issue')).toBeVisible();
    await expect(widgetFrame.getByText('CIO · Project')).toBeVisible();
    await expect(widgetFrame.getByText('Anti-Kickback Review')).toBeVisible();

    // No external Approve/Decline at all — the widget's own Confirm/Cancel
    // are the only controls, Cancel relabeled "Decline" for this card.
    await expect(page.getByRole('button', { name: 'Approve' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Decline', exact: true })).toHaveCount(0);
    await expect(widgetFrame.getByRole('button', { name: 'Decline' })).toBeVisible();

    const summaryInput = widgetFrame
      .locator('div')
      .filter({ hasText: /^Summary/ })
      .locator('input');
    await summaryInput.fill('Salesforce Incentive-Program Tracking — reviewed');
    await shot(page, testInfo, 'approval-widget-card-edited');

    await widgetFrame.getByRole('button', { name: 'Create' }).click();
    // Deciding an approval card archives it in the same stroke
    // (approvals.ts's decideApproval) — it leaves the default feed at
    // once, not just its live controls; the outcome line only shows in
    // the archived view.
    await expect(page.getByText('Nothing suggested yet.')).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('iframe[title="Approval preview"]')).toHaveCount(0);

    await page.goto(`/${fixture.slug}?archived=1`);
    await expect(page.getByText('You approved')).toBeVisible();
    await shot(page, testInfo, 'approval-widget-card-approved');

    const row = await client.query('SELECT status, result FROM actionable_items WHERE id = $1', [
      fixture.itemId,
    ]);
    expect(row.rows[0].status).toBe('approved');
    // Every editable field the card showed round-trips, not just summary —
    // "Anti-Kickback Review" was rendered too (unedited), so it comes back
    // unchanged alongside the actual edit.
    expect(row.rows[0].result.argsOverride).toEqual({
      summary: 'Salesforce Incentive-Program Tracking — reviewed',
      fields: { 'Anti-Kickback Review': 'Required' },
    });
  } finally {
    await client.query('DELETE FROM agent_jobs WHERE tenant_id = $1', [fixture.tenantId]);
    await client.query('DELETE FROM actionable_items WHERE id = $1', [fixture.itemId]);
    await client.query('DELETE FROM agent_runs WHERE id = $1', [fixture.runId]);
    await client.query('DELETE FROM agents WHERE id = $1', [fixture.agentId]);
    await client.end();
  }
});

test("the widget's own Cancel button is the decline — no separate control outside it", async ({
  page,
}, testInfo) => {
  const fixture = fixtureFor(`decline-${testInfo.project.name}`);
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    await seedTenant(client, fixture);
    await seedCard(client, fixture, {
      tool: 'jira_create_issue',
      args: { projectKey: 'CIO', issueType: 'Project', summary: 'Some proposed issue' },
    });
    await signIn(page, fixture);

    await page.goto(`/${fixture.slug}`);
    const widgetFrame = page.frameLocator('iframe[title="Approval preview"]');
    await expect(widgetFrame.getByText('Create Jira issue')).toBeVisible();

    // No external Approve/Decline at all — the widget's own Confirm/Cancel
    // (relabeled "Decline" for this card) are the only controls.
    await expect(page.getByRole('button', { name: 'Approve' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Decline', exact: true })).toHaveCount(0);
    await expect(widgetFrame.getByRole('button', { name: 'Create' })).toBeVisible();
    await expect(widgetFrame.getByRole('button', { name: 'Decline' })).toBeVisible();

    await widgetFrame.getByRole('button', { name: 'Decline' }).click();
    await expect(page.getByText('Nothing suggested yet.')).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('iframe[title="Approval preview"]')).toHaveCount(0);

    await page.goto(`/${fixture.slug}?archived=1`);
    await expect(page.getByText('You declined')).toBeVisible();

    const row = await client.query('SELECT status FROM actionable_items WHERE id = $1', [
      fixture.itemId,
    ]);
    expect(row.rows[0].status).toBe('declined');
  } finally {
    await client.query('DELETE FROM agent_jobs WHERE tenant_id = $1', [fixture.tenantId]);
    await client.query('DELETE FROM actionable_items WHERE id = $1', [fixture.itemId]);
    await client.query('DELETE FROM agent_runs WHERE id = $1', [fixture.runId]);
    await client.query('DELETE FROM agents WHERE id = $1', [fixture.agentId]);
    await client.end();
  }
});
