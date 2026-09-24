/**
 * The card feed's "Wants to call …" block (cards.tsx's ProposedCall).
 *
 * Started as a fix for one bug — an object-valued arg (`jira_create_issue`'s
 * `fields` escape hatch) rendering as the literal text "[object Object]"
 * because the generic arg list ran every value through bare `String()`.
 * Grew from there into dedicated cards for the two tool families common
 * enough to be worth it, mirroring the chat-side MCP Apps preview cards
 * (issue-preview.ts, email-compose.ts) instead of dumping raw args:
 *   - a Jira/JSM issue call gets a project/type header, summary,
 *     description, and its extra fields as rows (IssueProposedCall);
 *   - an Outlook send/reply/forward call gets To/Cc/Bcc, subject, and body
 *     (EmailProposedCall);
 *   - anything else still falls back to a plain, but now JSON-safe, arg
 *     list (GenericProposedCall).
 *
 * Each test gets its own tenant (AGENTS.md's rule for a spec that creates
 * rows, not just reads seeded fixtures): the three Playwright projects run
 * concurrently against one database, and the home feed shows every
 * unarchived card for a tenant, so two tests sharing one would each see the
 * other's "Wants to call …" card too.
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

/** This test's own tenant/session/slug — isolated from every other test and project. */
function fixtureFor(name: string): {
  tenantId: string;
  sessionId: string;
  slug: string;
  subject: string;
} {
  return {
    tenantId: uuidFrom(`actionable-cards-e2e-tenant:${name}`),
    sessionId: uuidFrom(`actionable-cards-e2e-session:${name}`),
    slug: `e2e-actionable-cards-${name}`,
    subject: `e2e-actionable-cards-${name}@example.com`,
  };
}

async function seedTenant(client: Client, fixture: ReturnType<typeof fixtureFor>): Promise<void> {
  await client.query('DELETE FROM actionable_items WHERE tenant_id = $1', [fixture.tenantId]);
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
  // No welcome-tour overlay stealing focus mid-screenshot (coach-marks.spec.ts).
  await client.query(
    `INSERT INTO user_preferences (tenant_id, subject, key, value)
     VALUES ($1, $2, 'coach_marks', '{"autoStart": false}'::jsonb)`,
    [fixture.tenantId, fixture.subject]
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

async function seedCard(
  client: Client,
  tenantId: string,
  itemId: string,
  title: string,
  suggestedAction: unknown
): Promise<void> {
  await client.query(
    `INSERT INTO actionable_items
       (id, tenant_id, source, kind, status, title, summary, evidence, suggested_action)
     VALUES ($1, $2, 'jira', 'approval', 'suggested', $3, 'Wants to call a tool.', '{}'::jsonb, $4::jsonb)`,
    [itemId, tenantId, title, JSON.stringify(suggestedAction)]
  );
}

async function shot(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  await page.screenshot({
    path: path.join(RESULTS, 'screens', testInfo.project.name, `${name}.png`),
    fullPage: true,
  });
}

test('a Jira issue call renders as a structured issue card', async ({ page }, testInfo) => {
  const fixture = fixtureFor(`issue-${testInfo.project.name}`);
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    await seedTenant(client, fixture);
    await signIn(page, fixture);
    const itemId = uuidFrom(`actionable-cards-e2e-issue-item:${testInfo.project.name}`);
    // jira_create_issue_confirm, not jira_create_issue: the plain tool now
    // hosts the real issue-preview widget instead of this native card
    // while suggested (approval-widget-card.spec.ts covers that) — this
    // spec is about the fallback rendering every OTHER Jira-issue-shaped
    // tool still gets, and _confirm shares the exact same args contract.
    await seedCard(
      client,
      fixture.tenantId,
      itemId,
      'Portfolio Updater — Create the approved issue',
      {
        tool: 'jira_create_issue_confirm',
        args: {
          projectKey: 'CIO',
          issueType: 'Project',
          summary: 'Salesforce Incentive-Program Tracking',
          description: 'Evidence: Scott + Dr. Jew/June meeting note.',
          fields: {
            'Anti-Kickback Review': 'Required',
            reviewers: ['scott', 'dr.jew'],
          },
        },
      }
    );

    await page.goto(`/${fixture.slug}`);
    await expect(page.getByText('Wants to call Create issue confirm')).toBeVisible();

    // Project/type header instead of raw "projectKey: CIO" / "issueType:
    // Project" rows — the same header shape the chat preview card shows.
    await expect(page.getByText('CIO · Project')).toBeVisible();
    await expect(page.getByText('Salesforce Incentive-Program Tracking')).toBeVisible();
    await expect(page.getByText('Evidence: Scott + Dr. Jew/June meeting note.')).toBeVisible();

    // The `fields` escape hatch used to collapse to one "[object Object]"
    // line; each of its entries is now its own labelled row.
    await expect(page.getByText('[object Object]')).toHaveCount(0);
    await expect(page.getByText('Anti-Kickback Review:')).toBeVisible();
    await expect(page.getByText('Required')).toBeVisible();
    await expect(page.getByText('reviewers:')).toBeVisible();
    await expect(page.getByText('scott, dr.jew')).toBeVisible();
    await shot(page, testInfo, 'actionable-cards-issue');

    await page.setViewportSize(MOBILE_VIEWPORT);
    await expect(page.getByText('CIO · Project')).toBeVisible();
    await expect(page.getByText('[object Object]')).toHaveCount(0);
    await shot(page, testInfo, 'actionable-cards-issue-mobile');
  } finally {
    await client.end();
  }
});

test('an Outlook send-mail call renders as a structured email card', async ({ page }, testInfo) => {
  const fixture = fixtureFor(`email-${testInfo.project.name}`);
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    await seedTenant(client, fixture);
    await signIn(page, fixture);
    const itemId = uuidFrom(`actionable-cards-e2e-email-item:${testInfo.project.name}`);
    await seedCard(client, fixture.tenantId, itemId, 'Portfolio Updater — Send the weekly digest', {
      tool: 'outlook_send_mail',
      args: {
        to: ['scott@example.com', 'dr.jew@example.com'],
        cc: ['rebecca@example.com'],
        subject: 'Weekly incentive-tracking digest',
        body: 'Salesforce remains the preferred long-term option.',
      },
    });

    await page.goto(`/${fixture.slug}`);
    await expect(page.getByText('Wants to call Send mail')).toBeVisible();

    await expect(page.getByText('To:')).toBeVisible();
    await expect(page.getByText('scott@example.com, dr.jew@example.com')).toBeVisible();
    await expect(page.getByText('Cc:')).toBeVisible();
    await expect(page.getByText('rebecca@example.com')).toBeVisible();
    await expect(page.getByText('Weekly incentive-tracking digest')).toBeVisible();
    await expect(
      page.getByText('Salesforce remains the preferred long-term option.')
    ).toBeVisible();
    await shot(page, testInfo, 'actionable-cards-email');
  } finally {
    await client.end();
  }
});

test('a tool outside the dedicated cards still falls back to a JSON-safe arg list', async ({
  page,
}, testInfo) => {
  const fixture = fixtureFor(`generic-${testInfo.project.name}`);
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    await seedTenant(client, fixture);
    await signIn(page, fixture);
    const itemId = uuidFrom(`actionable-cards-e2e-generic-item:${testInfo.project.name}`);
    await seedCard(client, fixture.tenantId, itemId, 'Portfolio Updater — Deploy the channel', {
      tool: 'mirth_deploy_channels',
      args: {
        channelIds: ['channel-a', 'channel-b'],
        options: { force: true },
      },
    });

    await page.goto(`/${fixture.slug}`);
    await expect(page.getByText('Wants to call Deploy channels')).toBeVisible();

    await expect(page.getByText('[object Object]')).toHaveCount(0);
    await expect(page.getByText('channelIds:')).toBeVisible();
    await expect(page.getByText('["channel-a","channel-b"]')).toBeVisible();
    await expect(page.getByText('options:')).toBeVisible();
    await expect(page.getByText('{"force":true}')).toBeVisible();
    await shot(page, testInfo, 'actionable-cards-generic');
  } finally {
    await client.end();
  }
});
