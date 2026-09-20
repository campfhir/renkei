/**
 * The coach marks, end to end: a newcomer lands on the home page and the
 * welcome tour starts on its own; each step is captured; Finish records
 * a completion and the tour stays away; Skip records a dismissal; the
 * Tutorials page behind the avatar shows every tour's state and replays
 * one; "Don't show tutorials" and the page's switch both stop tours
 * starting unasked; and the operator's report shows the rows.
 *
 * Signs in as a subject of its own — one per project, since the three
 * projects run side by side against one database — so the shared `e2e`
 * person (tours switched off by the seed) keeps every other spec free of
 * overlays, and this spec's rows are its own to assert on.
 */

import path from 'node:path';
import { createHash } from 'node:crypto';
import { test, expect, type Page, type TestInfo } from '@playwright/test';
import { Client } from 'pg';
import { E2E_SLUG, E2E_TENANT_ID } from './seed';

test.describe.configure({ mode: 'serial' });

/** This project's own person and session — stable, so the cookie can be set before the rows are. */
const subjectFor = (project: string) => `e2e-coach-${project}@example.com`;
const displayNameFor = (project: string) => `Coach Tester (${project})`;
function sessionIdFor(project: string): string {
  const hex = createHash('sha1').update(`coach-marks:${project}`).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

test.use({
  launchOptions: {
    executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    args: ['--no-sandbox'],
  },
  // Every context this spec opens is this project's person, not the shared
  // e2e user: the cookie has the same name as storageState's, so it wins.
  storageState: async (_fixtures, use, testInfo) => {
    await use({
      cookies: [
        {
          name: `renkei_session_${E2E_TENANT_ID}`,
          value: sessionIdFor(testInfo.project.name),
          domain: '127.0.0.1',
          path: '/',
          expires: -1,
          httpOnly: true,
          secure: false,
          sameSite: 'Lax',
        },
      ],
      origins: [],
    });
  },
});

const CARD = 'coach-mark';

async function shot(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  // The spotlight slides between steps (a 200ms transition): let it land.
  await page.waitForTimeout(350);
  await page.screenshot({
    path: path.join(
      import.meta.dirname,
      '..',
      'test-results',
      'screens',
      testInfo.project.name,
      `${name}.png`
    ),
    // The overlay is fixed to the viewport; a full-page resize would move it.
    fullPage: false,
  });
}

/** A moment longer than the engine's own half-second delay before a tour starts. */
async function expectNoTour(page: Page): Promise<void> {
  await page.waitForTimeout(1200);
  await expect(page.getByTestId(CARD)).toHaveCount(0);
}

interface ProgressRow {
  status: string;
  step_reached: number;
  steps_total: number;
  view_count: number;
  completed_count: number;
  dismissed_count: number;
}

let client: Client;
let subject: string;
let displayName: string;

async function progressOf(tourId: string): Promise<ProgressRow | null> {
  const result = await client.query<ProgressRow>(
    `SELECT status, step_reached, steps_total, view_count, completed_count, dismissed_count
       FROM coach_mark_progress
      WHERE tenant_id = $1 AND subject = $2 AND tour_id = $3`,
    [E2E_TENANT_ID, subject, tourId]
  );
  return result.rows[0] ?? null;
}

async function autoStartPref(): Promise<boolean | null> {
  const result = await client.query<{ value: { autoStart?: boolean } }>(
    `SELECT value FROM user_preferences
      WHERE tenant_id = $1 AND subject = $2 AND key = 'coach_marks'`,
    [E2E_TENANT_ID, subject]
  );
  return result.rows[0]?.value.autoStart ?? null;
}

test.beforeAll(async (_fixtures, testInfo) => {
  subject = subjectFor(testInfo.project.name);
  displayName = displayNameFor(testInfo.project.name);
  client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  // A clean slate for this person: no rows, no preference, a fresh session.
  await client.query('DELETE FROM coach_mark_progress WHERE tenant_id = $1 AND subject = $2', [
    E2E_TENANT_ID,
    subject,
  ]);
  await client.query('DELETE FROM user_preferences WHERE tenant_id = $1 AND subject = $2', [
    E2E_TENANT_ID,
    subject,
  ]);
  await client.query('DELETE FROM sessions WHERE tenant_id = $1 AND subject = $2', [
    E2E_TENANT_ID,
    subject,
  ]);
  await client.query(
    `INSERT INTO identities (tenant_id, subject, email, display_name)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (tenant_id, subject) DO UPDATE SET display_name = EXCLUDED.display_name`,
    [E2E_TENANT_ID, subject, subject, displayName]
  );
  await client.query(
    `INSERT INTO sessions (id, tenant_id, subject, roles, expires_at)
     VALUES ($1, $2, $3, $4, NOW() + INTERVAL '1 day')`,
    [
      sessionIdFor(testInfo.project.name),
      E2E_TENANT_ID,
      subject,
      ['renkei-user', 'renkei-operator'],
    ]
  );
});

test.afterAll(async () => {
  await client.end();
});

test('the welcome tour greets a newcomer on the home page and records a completion', async ({
  page,
}, testInfo) => {
  await page.goto(`/${E2E_SLUG}`);
  const card = page.getByTestId(CARD);
  await expect(card).toBeVisible();
  await expect(card).toHaveAttribute('data-coach-tour', 'welcome');
  await expect(card).toHaveAttribute('data-coach-step', 'intro');
  await expect(card).toContainText('1 of 6');
  // An intro has no target: the card sits centred, nothing is spotlit.
  await expect(page.getByTestId('coach-mark-spotlight')).toHaveCount(0);
  await shot(page, testInfo, 'coach-welcome-1-intro');

  await card.getByRole('button', { name: 'Next' }).click();
  await expect(card).toHaveAttribute('data-coach-step', 'feed');
  await expect(page.getByTestId('coach-mark-spotlight')).toBeVisible();
  await shot(page, testInfo, 'coach-welcome-2-feed');

  await card.getByRole('button', { name: 'Next' }).click();
  await expect(card).toHaveAttribute('data-coach-step', 'workspace');
  if (testInfo.project.name !== 'mobile') {
    // The menu column is on screen: the light is on it.
    await expect(page.getByTestId('coach-mark-spotlight')).toBeVisible();
  } else {
    // On a phone the column is a drawer, parked off screen: no spotlight,
    // and the card is still readable — the copy is written for that.
    await expect(page.getByTestId('coach-mark-spotlight')).toHaveCount(0);
  }
  await shot(page, testInfo, 'coach-welcome-3-workspace');

  // Back goes back; the arrow keys work too.
  await card.getByRole('button', { name: 'Back' }).click();
  await expect(card).toHaveAttribute('data-coach-step', 'feed');
  await page.keyboard.press('ArrowRight');
  await expect(card).toHaveAttribute('data-coach-step', 'workspace');

  await card.getByRole('button', { name: 'Next' }).click();
  await expect(card).toHaveAttribute('data-coach-step', 'chat');
  await card.getByRole('button', { name: 'Next' }).click();
  await expect(card).toHaveAttribute('data-coach-step', 'account');
  await expect(page.getByTestId('coach-mark-spotlight')).toBeVisible();
  await shot(page, testInfo, 'coach-welcome-5-account');

  await card.getByRole('button', { name: 'Next' }).click();
  await expect(card).toHaveAttribute('data-coach-step', 'done');
  await expect(card).toContainText('6 of 6');
  await shot(page, testInfo, 'coach-welcome-6-done');
  await card.getByRole('button', { name: 'Finish' }).click();
  await expect(card).toHaveCount(0);

  await expect
    .poll(() => progressOf('welcome'), { message: 'the completion is recorded' })
    .toMatchObject({
      status: 'completed',
      step_reached: 5,
      steps_total: 6,
      view_count: 1,
      completed_count: 1,
      dismissed_count: 0,
    });

  // Finished means finished: it does not come back.
  await page.reload();
  await expect(page.getByRole('heading', { level: 1, name: 'Actionable items' })).toBeVisible();
  await expectNoTour(page);
});

test('skipping a tour records the dismissal and where it happened', async ({ page }, testInfo) => {
  await page.goto(`/${E2E_SLUG}/agents`);
  const card = page.getByTestId(CARD);
  await expect(card).toBeVisible();
  await expect(card).toHaveAttribute('data-coach-tour', 'agents');
  await expect(card).toHaveAttribute('data-coach-step', 'new');
  // A tour that started unasked offers the way to stop them all.
  await expect(card.getByRole('button', { name: "Don't show tutorials" })).toBeVisible();
  await shot(page, testInfo, 'coach-agents-1-new');

  await card.getByRole('button', { name: 'Next' }).click();
  await expect(card).toHaveAttribute('data-coach-step', 'import');
  await card.getByRole('button', { name: 'Skip tour' }).click();
  await expect(card).toHaveCount(0);

  await expect
    .poll(() => progressOf('agents'))
    .toMatchObject({
      status: 'dismissed',
      step_reached: 1,
      steps_total: 3,
      view_count: 1,
      completed_count: 0,
      dismissed_count: 1,
    });

  await page.reload();
  await expect(page.getByRole('heading', { level: 1, name: 'Agents' })).toBeVisible();
  await expectNoTour(page);
});

test('Escape skips as well', async ({ page }) => {
  await page.goto(`/${E2E_SLUG}/connectors`);
  const card = page.getByTestId(CARD);
  await expect(card).toBeVisible();
  await expect(card).toHaveAttribute('data-coach-tour', 'connectors');
  await page.keyboard.press('Escape');
  await expect(card).toHaveCount(0);
  await expect
    .poll(() => progressOf('connectors'))
    .toMatchObject({
      status: 'dismissed',
      dismissed_count: 1,
    });
});

test('the Tutorials page lists every tour with its state and replays one', async ({
  page,
}, testInfo) => {
  await page.goto(`/${E2E_SLUG}/agents`);
  await page.getByRole('button', { name: 'Account menu' }).click();
  await page.getByRole('menu').getByRole('menuitem', { name: 'Tutorials' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Tutorials' })).toBeVisible();

  await expect(page.getByTestId('tutorial-welcome')).toContainText('Completed');
  await expect(page.getByTestId('tutorial-agents')).toContainText('Skipped');
  await expect(page.getByTestId('tutorial-agents')).toContainText('at step 2 of 3');
  await expect(page.getByTestId('tutorial-connectors')).toContainText('Skipped');
  await expect(page.getByTestId('tutorial-chat')).toContainText('Not started');
  // This person is an operator, so the console's tour is offered too.
  await expect(page.getByTestId('tutorial-admin')).toContainText('Operators');
  await expect(page.getByRole('switch', { name: 'Show tours automatically' })).toBeChecked();
  await shot(page, testInfo, 'coach-tutorials');

  // Replay: back to the home page, tour running, no "don't show" offer —
  // they asked for this one.
  await page.getByTestId('tutorial-welcome').getByRole('button', { name: 'Replay' }).click();
  const card = page.getByTestId(CARD);
  await expect(card).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`/${E2E_SLUG}$`));
  await expect(card).toHaveAttribute('data-coach-tour', 'welcome');
  await expect(card.getByRole('button', { name: "Don't show tutorials" })).toHaveCount(0);
  await shot(page, testInfo, 'coach-replay');
  await card.getByRole('button', { name: 'Skip tour' }).click();
  await expect(card).toHaveCount(0);

  // The replay is a second pass: the first completion is still counted.
  await expect
    .poll(() => progressOf('welcome'))
    .toMatchObject({
      status: 'dismissed',
      view_count: 2,
      completed_count: 1,
      dismissed_count: 1,
    });

  // Start, for a tour never taken: the chat's, which begins on a fresh thread.
  await page.goto(`/${E2E_SLUG}/tutorials`);
  await page.getByTestId('tutorial-chat').getByRole('button', { name: 'Start' }).click();
  await expect(card).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`/${E2E_SLUG}/chat/[0-9a-f-]{36}`));
  await expect(card).toHaveAttribute('data-coach-tour', 'chat');
  await expect(card).toHaveAttribute('data-coach-step', 'composer');
  await expect(page.getByTestId('coach-mark-spotlight')).toBeVisible();
  await shot(page, testInfo, 'coach-chat-1-composer');
  await card.getByRole('button', { name: 'Next' }).click();
  await expect(card).toHaveAttribute('data-coach-step', 'tools');
  await shot(page, testInfo, 'coach-chat-2-tools');
  await card.getByRole('button', { name: 'Next' }).click();
  await expect(card).toHaveAttribute('data-coach-step', 'model');
  await card.getByRole('button', { name: 'Next' }).click();
  await expect(card).toHaveAttribute('data-coach-step', 'send');
  await shot(page, testInfo, 'coach-chat-4-send');
  await card.getByRole('button', { name: 'Finish' }).click();
  await expect(card).toHaveCount(0);
  await expect
    .poll(() => progressOf('chat'))
    .toMatchObject({
      status: 'completed',
      completed_count: 1,
    });
});

test('"Don\'t show tutorials" and the switch both stop tours starting unasked', async ({
  page,
}, testInfo) => {
  // The operator console's tour has not been seen: it starts, and the
  // offer to stop them all is taken.
  await page.goto(`/${E2E_SLUG}/admin`);
  const card = page.getByTestId(CARD);
  await expect(card).toBeVisible();
  await expect(card).toHaveAttribute('data-coach-tour', 'admin');
  await shot(page, testInfo, 'coach-admin-console');
  await card.getByRole('button', { name: "Don't show tutorials" }).click();
  await expect(card).toHaveCount(0);
  await expect.poll(() => autoStartPref()).toBe(false);
  await expect.poll(() => progressOf('admin')).toMatchObject({ status: 'dismissed' });

  // The switch on the Tutorials page reads the change, and flips it back.
  await page.goto(`/${E2E_SLUG}/tutorials`);
  const toggle = page.getByRole('switch', { name: 'Show tours automatically' });
  await expect(toggle).not.toBeChecked();
  await shot(page, testInfo, 'coach-tutorials-off');

  // Off: a tour never taken (the agents' was skipped; reset it) stays away.
  await client.query(
    'DELETE FROM coach_mark_progress WHERE tenant_id = $1 AND subject = $2 AND tour_id = $3',
    [E2E_TENANT_ID, subject, 'agents']
  );
  await page.goto(`/${E2E_SLUG}/agents`);
  await expect(page.getByRole('heading', { level: 1, name: 'Agents' })).toBeVisible();
  await expectNoTour(page);

  // On again: it comes.
  await page.goto(`/${E2E_SLUG}/tutorials`);
  await toggle.click();
  await expect(toggle).toBeChecked();
  await expect.poll(() => autoStartPref()).toBe(true);
  await page.goto(`/${E2E_SLUG}/agents`);
  await expect(card).toBeVisible();
  await expect(card).toHaveAttribute('data-coach-tour', 'agents');
  await card.getByRole('button', { name: 'Skip tour' }).click();
  await expect(card).toHaveCount(0);
});

test('the operator report shows who viewed, finished and skipped', async ({ page }, testInfo) => {
  await page.goto(`/${E2E_SLUG}/admin/tutorials`);
  await expect(page.getByRole('heading', { level: 1, name: 'Tutorials' })).toBeVisible();
  // The totals count everyone in the tenant — the other projects' people
  // included — so the assertion is on this person's own row.
  const row = page.getByTestId('tutorial-person').filter({ hasText: displayName });
  await expect(row).toHaveCount(1);
  const cells = row.getByRole('cell');
  await expect(cells.nth(1)).toHaveText('Skipped'); // welcome: replayed, then skipped
  await expect(cells.nth(2)).toHaveText('Skipped'); // agents
  await expect(cells.nth(3)).toHaveText('Completed'); // chat
  await expect(cells.nth(4)).toHaveText('Skipped'); // connectors: Escape
  await expect(cells.nth(5)).toHaveText('Skipped'); // admin: "don't show"
  await expect(page.getByTestId('tour-totals-welcome')).toBeVisible();
  await shot(page, testInfo, 'coach-admin-report');
});
