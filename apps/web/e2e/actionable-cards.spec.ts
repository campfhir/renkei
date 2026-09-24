/**
 * The card feed's "Wants to call …" block (cards.tsx's ProposedCall): an
 * approval card renders every arg of the proposed tool call as `key: value`.
 * Bug: an object-valued arg — `jira_create_issue`'s `fields` escape hatch is
 * the one that bit — went through bare `String(value)`, so it rendered as
 * the literal text "[object Object]" instead of the JSON it actually holds.
 *
 * Seeded straight into `actionable_items` (no UI writes it), the same way
 * widget-card.spec.ts seeds its chat rows: a real row in the shared `e2e`
 * tenant, its own id per project so the three Playwright projects running
 * concurrently against one database never collide or race on cleanup.
 */

import { createHash } from 'node:crypto';
import path from 'node:path';
import { test, expect, type Page, type TestInfo } from '@playwright/test';
import { Client } from 'pg';
import { E2E_SLUG, E2E_TENANT_ID } from './seed';

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

const FIELDS_ARG = {
  'Anti-Kickback Review': 'Required',
  reviewers: ['scott', 'dr.jew'],
};

async function seedCard(client: Client, itemId: string): Promise<void> {
  await client.query('DELETE FROM actionable_items WHERE id = $1', [itemId]);
  await client.query(
    `INSERT INTO actionable_items
       (id, tenant_id, source, kind, status, title, summary, evidence, suggested_action)
     VALUES ($1, $2, 'jira', 'approval', 'suggested', $3, $4, '{}'::jsonb, $5::jsonb)`,
    [
      itemId,
      E2E_TENANT_ID,
      'Portfolio Updater — Create the approved issue',
      'Wants to call Create issue.',
      JSON.stringify({
        tool: 'jira_create_issue',
        args: {
          projectKey: 'CIO',
          issueType: 'Project',
          summary: 'Salesforce Incentive-Program Tracking',
          fields: FIELDS_ARG,
        },
      }),
    ]
  );
}

async function shot(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  await page.screenshot({
    path: path.join(RESULTS, 'screens', testInfo.project.name, `${name}.png`),
    fullPage: true,
  });
}

test('an object-valued arg in "Wants to call" renders as JSON, not "[object Object]"', async ({
  page,
}, testInfo) => {
  const itemId = uuidFrom(`actionable-cards-e2e:${testInfo.project.name}`);
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    await seedCard(client, itemId);

    await page.goto(`/${E2E_SLUG}`);
    const card = page.locator('div', { has: page.getByText('Wants to call Create issue') });
    await expect(card.first()).toBeVisible();

    // The primitive args still print plainly.
    await expect(page.getByText('projectKey: CIO')).toBeVisible();
    await expect(page.getByText('issueType: Project')).toBeVisible();

    // The object-valued `fields` arg used to print as "[object Object]" — it
    // must now be its actual JSON, keys and all. (jsonb round-trips through
    // Postgres key-reordered, so match the fields item's text rather than a
    // literal JSON.stringify of the object as sent.)
    const fieldsItem = page.getByText(/^fields: \{.*\}$/);
    await expect(page.getByText('[object Object]')).toHaveCount(0);
    await expect(fieldsItem).toBeVisible();
    await expect(fieldsItem).toContainText('Anti-Kickback Review');
    await expect(fieldsItem).toContainText('reviewers');
    await expect(fieldsItem).toContainText('dr.jew');
    await shot(page, testInfo, 'actionable-cards-fields-json');

    await page.setViewportSize(MOBILE_VIEWPORT);
    await expect(page.getByText('[object Object]')).toHaveCount(0);
    await expect(fieldsItem).toBeVisible();
    await shot(page, testInfo, 'actionable-cards-fields-json-mobile');
  } finally {
    await client.query('DELETE FROM actionable_items WHERE id = $1', [itemId]);
    await client.end();
  }
});
