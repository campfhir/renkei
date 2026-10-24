/**
 * The global keyboard shortcuts, end to end: the key caps match the OS
 * (⌘ on a Mac, Ctrl elsewhere — the browser's platform is faked both ways),
 * the quick-chat modal starts a chat from any page with Enter, the
 * recent-chats switcher walks the list and opens a chat, and the shortcuts
 * coach marks follow the welcome tour on the home page.
 *
 * The first turn's POST is answered at the browser edge — there is no model
 * to run it in e2e — so the chat itself is real and the reply is not.
 *
 * A person of its own per project (projects run side by side on one
 * database), with the tours off except in the coach-marks test.
 */

import path from 'node:path';
import { createHash } from 'node:crypto';
import { test, expect, type Locator, type Page, type TestInfo } from '@playwright/test';
import { Client } from 'pg';
import { enrollForE2E } from './keys';

test.describe.configure({ mode: 'serial' });

const subjectFor = (project: string) => `e2e-shortcuts-${project}@example.com`;
function sessionIdFor(project: string): string {
  const hex = createHash('sha1').update(`global-shortcuts:${project}`).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

test.use({
  launchOptions: {
    executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    args: ['--no-sandbox'],
  },
  // eslint-disable-next-line no-empty-pattern
  storageState: async ({}, use, testInfo) => {
    await use({
      cookies: [
        {
          name: `renkei_session`,
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

const MOBILE_VIEWPORT = { width: 390, height: 844 };
let client: Client;
let subject: string;

async function shot(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  await page.screenshot({
    path: path.join(
      import.meta.dirname,
      '..',
      'test-results',
      'screens',
      testInfo.project.name,
      `${name}.png`
    ),
  });
}

/** Pretend to be a Mac (or not) before any page script runs. */
async function fakePlatform(page: Page, platform: 'MacIntel' | 'Win32'): Promise<void> {
  await page.addInitScript((value) => {
    Object.defineProperty(navigator, 'platform', { get: () => value });
    Object.defineProperty(navigator, 'userAgentData', { get: () => undefined });
  }, platform);
}

/** Press a shortcut until its dialog is up — the first press can land before the page has hydrated. */
async function pressUntilOpen(page: Page, key: string, dialog: Locator): Promise<void> {
  await expect(async () => {
    await page.keyboard.press(key);
    await expect(dialog).toBeVisible({ timeout: 700 });
  }).toPass({ timeout: 15_000 });
}

async function makeChat(title: string, updatedMinutesAgo: number): Promise<string> {
  const created = await client.query<{ id: string }>(
    `INSERT INTO chats (owner_subject, title, last_message_at, updated_at)
     VALUES ($1, $2, NOW() - make_interval(mins => $3), NOW() - make_interval(mins => $3))
     RETURNING id`,
    [subject, title, updatedMinutesAgo]
  );
  return created.rows[0].id;
}

// eslint-disable-next-line no-empty-pattern
test.beforeAll(async ({}, testInfo) => {
  subject = subjectFor(testInfo.project.name);
  client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  await client.query('DELETE FROM chats WHERE owner_subject = $1', [subject]);
  await client.query('DELETE FROM coach_mark_progress WHERE subject = $1', [subject]);
  await client.query('DELETE FROM user_preferences WHERE subject = $1', [subject]);
  await client.query('DELETE FROM sessions WHERE subject = $1', [subject]);
  await client.query(
    `INSERT INTO sessions (id, subject, roles, expires_at)
     VALUES ($1, $2, $3, NOW() + INTERVAL '1 day')`,
    [sessionIdFor(testInfo.project.name), subject, ['renkei-user', 'renkei-operator']]
  );
  // Enrolled with a key, so the key dialog does not sit over a chat page.
  await enrollForE2E(client, subject);
  await client.query(
    `INSERT INTO user_preferences (subject, key, value)
     VALUES ($1, 'coach_marks', '{"autoStart": false}'::jsonb)`,
    [subject]
  );
});

test.afterAll(async () => {
  await client.query('DELETE FROM chats WHERE owner_subject = $1', [subject]);
  await client.end();
});

test('the search hint shows the key for this OS', async ({ page }, testInfo) => {
  await fakePlatform(page, 'MacIntel');
  await page.goto(`/agents`);
  await expect(page.locator('kbd', { hasText: '⌘ K' })).toBeVisible();
  await shot(page, testInfo, 'shortcuts-hint-mac');

  const other = await page.context().newPage();
  await fakePlatform(other, 'Win32');
  await other.goto(`/agents`);
  await expect(other.locator('kbd', { hasText: 'Ctrl K' })).toBeVisible();
});

test('quick chat starts a chat from any page with Enter', async ({ page }, testInfo) => {
  await fakePlatform(page, 'Win32');
  let sent: { text?: string } | null = null;
  await page.route('**/api/chat/chats/*/turns', async (route) => {
    sent = route.request().postDataJSON();
    await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  });

  await page.goto(`/agents`);
  await page.keyboard.press('Control+j');
  const dialog = page.getByRole('dialog', { name: 'New chat' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel('Prompt')).toBeFocused();
  await shot(page, testInfo, 'shortcuts-quick-chat');

  // Enter with nothing typed does nothing.
  await page.keyboard.press('Enter');
  await expect(dialog).toBeVisible();

  await page.keyboard.type('Summarise my week');
  await page.keyboard.press('Shift+Enter');
  await page.keyboard.type('in three bullets');
  await page.keyboard.press('Enter');

  // A cold dev server compiles the chat routes on this first hit.
  await expect(page).toHaveURL(/\/chat\/[0-9a-f-]{36}$/, { timeout: 30_000 });
  expect(sent).toEqual(expect.objectContaining({ text: 'Summarise my week\nin three bullets' }));
  await expect(dialog).toHaveCount(0);
});

test('quick chat uses the Command key on a Mac and works at phone width', async ({
  page,
}, testInfo) => {
  await fakePlatform(page, 'MacIntel');
  await page.setViewportSize(MOBILE_VIEWPORT);
  await page.goto(`/agents`);
  // Control+J is not the Mac shortcut.
  await page.keyboard.press('Control+j');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.keyboard.press('Meta+j');
  const dialog = page.getByRole('dialog', { name: 'New chat' });
  await expect(dialog).toBeVisible();
  const box = await dialog.locator('> div').boundingBox();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(MOBILE_VIEWPORT.width);
  await page.keyboard.type('Draft a reply to the vendor about the delayed invoice');
  await shot(page, testInfo, 'shortcuts-quick-chat-phone');
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
});

test('the switcher opens on the previous chat, walks the list and opens one', async ({
  page,
}, testInfo) => {
  // Opens three pages on a dev server that compiles each on first use.
  test.setTimeout(120_000);
  const newest = await makeChat('Quarterly report draft', 1);
  const middle = await makeChat('Expense policy question', 5);
  const oldest = await makeChat('Onboarding checklist', 10);

  await fakePlatform(page, 'Win32');
  await page.goto(`/chat/${newest}`);
  const dialog = page.getByRole('dialog', { name: 'Recent chats' });
  await pressUntilOpen(page, 'Alt+j', dialog);
  const options = dialog.getByRole('option');
  await expect(options.nth(0)).toContainText('Quarterly report draft');
  await expect(options.nth(0)).toContainText('Current');
  // On a chat, the switcher opens on the one before it.
  await expect(options.nth(1)).toHaveAttribute('aria-selected', 'true');
  await expect(options.nth(1)).toContainText('Expense policy question');
  await shot(page, testInfo, 'shortcuts-switcher');

  // Again moves on; Shift goes back.
  await page.keyboard.press('Alt+j');
  await expect(options.nth(2)).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('Alt+Shift+J');
  await expect(options.nth(1)).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('ArrowDown');
  await expect(options.nth(2)).toHaveAttribute('aria-selected', 'true');

  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(new RegExp(`/chat/${oldest}$`));
  await expect(dialog).toHaveCount(0);

  // From a page that is not a chat, it opens on the most recent one.
  await page.goto(`/agents`);
  await pressUntilOpen(page, 'Alt+j', dialog);
  await expect(dialog.getByRole('option').first()).toHaveAttribute('aria-selected', 'true');
  await expect(dialog.getByRole('option').first()).toContainText('Quarterly report draft');
  await dialog.getByRole('option', { name: /Expense policy/ }).click();
  await expect(page).toHaveURL(new RegExp(`/chat/${middle}$`));
});

test('the shortcuts coach marks follow the welcome tour on the home page', async ({
  page,
}, testInfo) => {
  await client.query('DELETE FROM user_preferences WHERE subject = $1', [subject]);
  await fakePlatform(page, 'MacIntel');
  const card = page.getByTestId('coach-mark');

  await page.goto(`/`);
  await expect(card).toHaveAttribute('data-coach-tour', 'welcome');
  await card.getByRole('button', { name: 'Skip tour' }).click();
  await expect(card).toHaveCount(0);
  // Settled on the server before the page is left, or the tour comes back.
  await expect
    .poll(async () => {
      const result = await client.query(
        `SELECT status FROM coach_mark_progress WHERE subject = $1 AND tour_id = 'welcome'`,
        [subject]
      );
      return result.rows[0]?.status;
    })
    .toBe('dismissed');

  // The next visit to the home page brings the shortcuts tour.
  await page.goto(`/`);
  await expect(card).toHaveAttribute('data-coach-tour', 'shortcuts');
  await expect(card).toHaveAttribute('data-coach-step', 'search');
  await expect(card).toContainText('⌘ K');
  await expect(page.getByTestId('coach-mark-spotlight')).toBeVisible();
  await page.waitForTimeout(350);
  await shot(page, testInfo, 'shortcuts-coach-1-search');

  await card.getByRole('button', { name: 'Next' }).click();
  await expect(card).toHaveAttribute('data-coach-step', 'quick-chat');
  await expect(card).toContainText('⌘ J');

  await card.getByRole('button', { name: 'Next' }).click();
  await expect(card).toHaveAttribute('data-coach-step', 'switch-chat');
  await expect(card).toContainText('⌥ J');
  await page.waitForTimeout(350);
  await shot(page, testInfo, 'shortcuts-coach-3-switch');

  await card.getByRole('button', { name: 'Finish' }).click();
  await expect(card).toHaveCount(0);
  await expect
    .poll(async () => {
      const result = await client.query(
        `SELECT status FROM coach_mark_progress WHERE subject = $1 AND tour_id = 'shortcuts'`,
        [subject]
      );
      return result.rows[0]?.status;
    })
    .toBe('completed');
});
