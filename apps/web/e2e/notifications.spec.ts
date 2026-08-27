/**
 * The notification surfaces, and the canvas mark.
 *
 * Unlike screenshots.spec.ts these carry real assertions, because the thing
 * they cover fails SILENTLY: both the feed row and the toast are made
 * clickable by a stretched `after:inset-0` pseudo-element, and a later
 * change to either card's positioning (dropping a `relative`, wrapping the
 * body in a new div) stops the click landing without changing how the page
 * looks at all. `elementFromPoint` at a corner of the card is the only
 * check that actually notices.
 *
 * Seeds its own notification rows: global-setup wipes tenant data before
 * every run, so there is nothing in the table by the time a test starts.
 */

import path from 'node:path';
import { test, expect, type Page, type TestInfo } from '@playwright/test';
import pg from 'pg';
import {
  E2E_SLUG,
  E2E_TENANT_ID,
  E2E_SUBJECT,
  AGENT_DEEP_ID,
  DEEP_LOOP_NAME,
  RUN_ITERATIONS_ID,
} from './seed';

// This sandbox ships a Chromium that Playwright's own resolver does not
// find; the pinned path plus --no-sandbox is what makes it launch here.
test.use({
  launchOptions: {
    executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    args: ['--no-sandbox'],
  },
});

async function shot(page: Page, testInfo: TestInfo, name: string, fullPage = true): Promise<void> {
  await page.screenshot({
    path: path.join(
      import.meta.dirname,
      '..',
      'test-results',
      'screens',
      testInfo.project.name,
      `${name}.png`
    ),
    fullPage,
  });
}

const ROWS = [
  {
    kind: 'act',
    category: 'sent',
    connector: 'microsoft',
    tool: 'outlook_send_mail',
    entity: 'email',
    // Deliberately linkless: /me/sendMail returns no id, so a plain send
    // genuinely has nothing to open. The row still has to render.
    headline: 'Sent an email “Q3 invoice follow-up”',
    ref_url: null,
  },
  {
    kind: 'act',
    category: 'created',
    connector: 'jira',
    tool: 'jira_create_issue',
    entity: 'issue',
    headline: 'Created a Jira issue PROJ-1042',
    ref_url: 'https://example.atlassian.net/browse/PROJ-1042',
    run_id: RUN_ITERATIONS_ID,
  },
  {
    kind: 'act',
    category: 'sent',
    connector: 'microsoft',
    tool: 'outlook_respond_event',
    entity: 'invitation',
    headline: 'Declined a meeting invitation to “Sprint review”',
    ref_url: null,
  },
  {
    kind: 'act',
    category: 'scheduled',
    connector: 'zoom',
    tool: 'zoom_create_meeting',
    entity: 'meeting',
    headline: 'Scheduled a Zoom meeting “Vendor sync”',
    ref_url: 'https://example.zoom.us/j/1234567890',
  },
];

async function seedNotifications(): Promise<void> {
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    await client.query('DELETE FROM agent_notifications WHERE tenant_id = $1', [E2E_TENANT_ID]);
    for (const [index, row] of ROWS.entries()) {
      await client.query(
        `INSERT INTO agent_notifications
           (id, tenant_id, subject, kind, category, connector, tool, entity, headline,
            ref_url, run_id, agent_id, agent_name, created_at)
         VALUES (gen_random_uuid(),$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,
                 now() - ($13 || ' minutes')::interval)`,
        [
          E2E_TENANT_ID,
          E2E_SUBJECT,
          row.kind,
          row.category,
          row.connector,
          row.tool,
          row.entity,
          row.headline,
          row.ref_url,
          'run_id' in row ? row.run_id : null,
          AGENT_DEEP_ID,
          'Triage yesterday into tickets',
          String(index * 7),
        ]
      );
    }
  } finally {
    await client.end();
  }
}

test('canvas — the fixed mark in the corner', async ({ page }, testInfo) => {
  await page.goto(`/${E2E_SLUG}/agents/${AGENT_DEEP_ID}/edit`);
  await expect(page.getByRole('button', { name: `Edit loop: ${DEEP_LOOP_NAME}` })).toBeVisible();

  // The mark is on the trigger cluster, the group, the foreach loop and the
  // ending — never on a step, and never on a branch.
  const marks = page.locator('[aria-label="Runs as fixed code — no model call"]');
  expect(await marks.count()).toBeGreaterThan(0);
  // Nothing spells the claim out any more.
  await expect(page.getByText('fixed', { exact: true })).toHaveCount(0);
  await shot(page, testInfo, 'review-canvas-fixed-mark');
});

test('notifications — the whole row opens the link', async ({ page }, testInfo) => {
  await seedNotifications();
  await page.goto(`/${E2E_SLUG}/notifications`);
  await expect(page.getByRole('heading', { name: 'Notifications' })).toBeVisible();

  const linked = page.getByRole('link', { name: 'Created a Jira issue PROJ-1042' });
  await expect(linked).toHaveAttribute('href', 'https://example.atlassian.net/browse/PROJ-1042');
  await expect(linked).toHaveAttribute('target', '_blank');

  // The stretched pseudo-element must actually cover the row: a click near
  // the row's left edge, far from the text, has to land on the anchor.
  const row = page.locator('li', { hasText: 'Created a Jira issue PROJ-1042' }).last();
  const box = await row.boundingBox();
  expect(box).not.toBeNull();
  const hit = await page.evaluate(
    ([x, y]) => {
      const element = document.elementFromPoint(x, y);
      const anchor = element?.closest('a');
      return anchor instanceof HTMLAnchorElement ? anchor.href : (element?.tagName ?? 'none');
    },
    [box!.x + box!.width - 90, box!.y + box!.height - 8]
  );
  expect(hit).toBe('https://example.atlassian.net/browse/PROJ-1042');

  // A declined invitation carries no link, and must not pretend to.
  await expect(page.getByRole('link', { name: /Declined a meeting invitation/ })).toHaveCount(0);
  await expect(page.getByText(/Declined a meeting invitation/)).toBeVisible();

  // Every per-card action lives in the ⋯ menu now — no standalone Run
  // link, no external-link arrow outside the menu.
  await expect(row.getByRole('link', { name: 'Run' })).toHaveCount(0);
  const menuButton = row.getByRole('button', { name: /Actions for/ });
  await expect(menuButton).toBeVisible();
  // ...and it has to be reachable through the stretched anchor.
  const menuBox = await menuButton.boundingBox();
  const menuHit = await page.evaluate(
    ([x, y]) => document.elementFromPoint(x, y)?.closest('button') !== null,
    [menuBox!.x + menuBox!.width / 2, menuBox!.y + menuBox!.height / 2]
  );
  expect(menuHit).toBe(true);

  await menuButton.click();
  await expect(page.getByRole('menuitem', { name: 'Open issue' })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: 'Show run' })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: 'Select' })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: 'Delete' })).toBeVisible();
  await shot(page, testInfo, 'review-notifications-menu', false);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('menuitem', { name: 'Delete' })).toHaveCount(0);

  await shot(page, testInfo, 'review-notifications');
});

test('notifications — select and delete through the menu', async ({ page }, testInfo) => {
  await seedNotifications();
  await page.goto(`/${E2E_SLUG}/notifications`);
  await expect(page.getByRole('heading', { name: 'Notifications' })).toBeVisible();

  // "Select" in a card's menu enters selection mode: checkboxes replace
  // the connector icons and the sticky footer appears.
  const row = page.locator('li', { hasText: 'Created a Jira issue PROJ-1042' }).last();
  await row.getByRole('button', { name: /Actions for/ }).click();
  await page.getByRole('menuitem', { name: 'Select' }).click();
  await expect(
    page.getByRole('checkbox', { name: 'Select "Created a Jira issue PROJ-1042"' })
  ).toBeChecked();
  await expect(page.getByText('1 selected')).toBeVisible();

  await page.getByRole('checkbox', { name: /Select "Scheduled a Zoom meeting/ }).check();
  await expect(page.getByText('2 selected')).toBeVisible();
  await shot(page, testInfo, 'review-notifications-selection', false);

  // The footer's Delete opens the confirmation — nothing is deleted yet.
  await page.getByRole('button', { name: 'Delete', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Confirm delete' });
  await expect(dialog.getByText('Delete 2 notifications?')).toBeVisible();
  await shot(page, testInfo, 'review-notifications-confirm', false);

  await dialog.getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(page.getByText('Created a Jira issue PROJ-1042')).toHaveCount(0);
  await expect(page.getByText(/Scheduled a Zoom meeting/)).toHaveCount(0);
  // Selection mode ended with its rows.
  await expect(page.getByText('2 selected')).toHaveCount(0);
});

test('preferences — acts enumerated per connector', async ({ page }, testInfo) => {
  await page.goto(`/${E2E_SLUG}/preferences`);
  await expect(page.getByRole('heading', { name: 'Preferences' })).toBeVisible();

  // No grid: the words that named its columns are gone.
  await expect(page.getByRole('columnheader')).toHaveCount(0);
  await expect(page.getByText('Anything else', { exact: true })).toHaveCount(0);

  await shot(page, testInfo, 'review-preferences-collapsed');

  const jira = page.locator('details', { hasText: 'Jira' }).first();
  await jira.locator('summary').click();
  await expect(page.getByText('Created an issue')).toBeVisible();
  await expect(page.getByText('Raised a service request')).toBeVisible();
  await expect(page.getByText('Moved an issue through its workflow')).toBeVisible();
  await expect(page.getByText('Anything else in Jira')).toBeVisible();
  await shot(page, testInfo, 'review-preferences-jira', false);

  // Outlook is where the user's own list came from — check it reads back.
  await page.locator('details', { hasText: 'Outlook' }).first().locator('summary').click();
  await expect(page.getByText('Accepted or declined an invitation')).toBeVisible();
  await expect(page.getByText('Moved an email to another folder')).toBeVisible();
  await shot(page, testInfo, 'review-preferences-outlook', false);
});

test('toast — the card opens its link, the dismiss still dismisses', async ({ page }) => {
  test.setTimeout(90_000);
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    await client.query('DELETE FROM agent_notifications WHERE tenant_id = $1', [E2E_TENANT_ID]);
    await page.goto(`/${E2E_SLUG}/agents`);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    // The centre seeds its cursor from the FIRST poll, so a row written
    // before that one lands is backlog and deliberately never toasts.
    await page.waitForTimeout(2_000);

    await client.query(
      `INSERT INTO agent_notifications
         (id, tenant_id, subject, kind, category, connector, tool, entity, headline,
          ref_url, agent_id, agent_name, created_at)
       VALUES (gen_random_uuid(),$1,$2,'act','created','jira','jira_create_issue','issue',
               $3,$4,$5,'Triage yesterday into tickets', now())`,
      [
        E2E_TENANT_ID,
        E2E_SUBJECT,
        'Created a Jira issue PROJ-2001',
        'https://example.atlassian.net/browse/PROJ-2001',
        AGENT_DEEP_ID,
      ]
    );

    const toast = page.getByRole('link', { name: 'Created a Jira issue PROJ-2001' });
    await expect(toast).toBeVisible({ timeout: 40_000 });
    await expect(toast).toHaveAttribute('href', 'https://example.atlassian.net/browse/PROJ-2001');

    // The stretched link has to cover the card without swallowing dismiss.
    const card = page.locator('article', { hasText: 'PROJ-2001' });
    const box = await card.boundingBox();
    const hit = await page.evaluate(
      ([x, y]) => document.elementFromPoint(x, y)?.closest('a')?.getAttribute('href') ?? 'none',
      [box!.x + 20, box!.y + box!.height - 10]
    );
    expect(hit).toBe('https://example.atlassian.net/browse/PROJ-2001');

    await card.getByRole('button', { name: 'Dismiss' }).click();
    await expect(toast).toHaveCount(0);
    expect(page.url()).toContain('/agents');
  } finally {
    await client.end();
  }
});
