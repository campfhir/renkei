/**
 * The global keyboard shortcuts, end to end: the key caps match the OS
 * (⌘ on a Mac, Ctrl elsewhere — the browser's platform is faked both ways),
 * the quick-chat modal (`c`) starts a chat from any page with Enter, the
 * recent-chats switcher (⌘/Ctrl J) walks the list and opens a
 * chat, the `c` key stands down in a text field and over a dialog, the ⌥/Alt
 * and ⌘/Ctrl chords go to pages from anywhere, and the shortcuts coach marks follow the welcome tour on
 * the home page.
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
import { enrollForE2E, secretbox } from './keys';
import { lockOrganization, unlockOrganization } from './org-lock';

// The organization's rows are shared by every spec in a run: this one holds the
// lock for its whole file, so the rows are its own while it runs.
test.beforeAll(lockOrganization);
test.afterAll(unlockOrganization);

test.describe.configure({ mode: 'serial' });

const subjectFor = (project: string) => `e2e-shortcuts-${project}@example.com`;
/** A stable, valid-looking UUID for this project's session and model. */
const uuidFor = (project: string, what: string): string => {
  const hex = createHash('sha1').update(`global-shortcuts:${what}:${project}`).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
};
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

/**
 * Type keys until what they do shows — the first press can land before the
 * page has hydrated. `settle` is how long one try waits for the effect (a
 * bare `c` waits half a second in case an `h` follows).
 */
async function pressUntil(
  page: Page,
  keys: string[],
  seen: () => Promise<void>,
  settle = 1500
): Promise<void> {
  await expect(async () => {
    for (const key of keys) await page.keyboard.press(key);
    await seen();
  }).toPass({ timeout: 20_000, intervals: [settle] });
}

/** Press a shortcut until its dialog is up. */
async function pressUntilOpen(
  page: Page,
  key: string,
  dialog: Locator,
  settle = 1500
): Promise<void> {
  await pressUntil(page, [key], () => expect(dialog).toBeVisible({ timeout: settle }), settle);
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
  // The composer needs a model to send with; the org has none unless a spec adds one.
  await client.query('DELETE FROM llm_model_configs WHERE id = $1', [
    uuidFor(testInfo.project.name, 'model'),
  ]);
  await client.query(
    `INSERT INTO llm_model_configs (id, label, provider, model, encrypted_secrets, enabled, is_default)
     VALUES ($1, $2, 'anthropic', 'e2e-model', $3, true, false)`,
    [
      uuidFor(testInfo.project.name, 'model'),
      `QC ${testInfo.project.name.replace('desktop-', '')}`,
      secretbox(
        JSON.stringify({ apiKey: 'e2e' }),
        Buffer.from(process.env.TOKEN_ENCRYPTION_KEY ?? '', 'base64')
      ),
    ]
  );
  await client.query(
    `INSERT INTO user_preferences (subject, key, value)
     VALUES ($1, 'coach_marks', '{"autoStart": false}'::jsonb)`,
    [subject]
  );
});

// eslint-disable-next-line no-empty-pattern
test.afterAll(async ({}, testInfo) => {
  await client.query('DELETE FROM chats WHERE owner_subject = $1', [subject]);
  await client.query('DELETE FROM llm_model_configs WHERE id = $1', [
    uuidFor(testInfo.project.name, 'model'),
  ]);
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

test('quick chat is the thread composer: attachments, model, prompts, and Enter to start', async ({
  page,
}, testInfo) => {
  await fakePlatform(page, 'Win32');
  let sent: { text?: string; attachmentIds?: string[]; llmModelId?: string } | null = null;
  await page.route('**/api/chat/chats/*/turns', async (route) => {
    sent = route.request().postDataJSON();
    await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  });

  await page.goto(`/agents`);
  const dialog = page.getByRole('dialog', { name: 'New chat' });
  // A cold dev server compiles the chat routes on this first hit.
  await expect(async () => {
    await page.keyboard.press('c');
    await expect(dialog.getByLabel('Message')).toBeVisible({ timeout: 2500 });
  }).toPass({ timeout: 40_000, intervals: [2500] });
  const box = dialog.getByLabel('Message');
  await expect(box).toBeFocused();
  // The composer's own controls, not a lookalike.
  await expect(dialog.getByRole('button', { name: 'Attach a file' })).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Insert a prompt' })).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Model' })).toContainText('QC ');
  await shot(page, testInfo, 'shortcuts-quick-chat');

  // Enter with nothing typed does nothing.
  await page.keyboard.press('Enter');
  await expect(dialog).toBeVisible();

  // The prompt picker opens over the box; Escape closes it and only it.
  await dialog.getByRole('button', { name: 'Insert a prompt' }).click();
  const picker = page.getByRole('dialog', { name: 'Insert a prompt' });
  await expect(picker).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(picker).toHaveCount(0);
  await expect(dialog).toBeVisible();

  // A file is uploaded on the new chat and shown as a chip.
  await dialog
    .locator('input[type="file"]')
    .first()
    .setInputFiles({
      name: 'meeting-notes.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('Decisions: ship on Friday.'),
    });
  await expect(dialog.getByText('meeting-notes.txt')).toBeVisible({ timeout: 20_000 });
  await shot(page, testInfo, 'shortcuts-quick-chat-attached');

  await box.fill('Summarise my week');
  await box.press('Shift+Enter');
  await box.pressSequentially('in three bullets');
  await page.keyboard.press('Enter');

  await expect(page).toHaveURL(/\/chat\/[0-9a-f-]{36}$/, { timeout: 30_000 });
  expect(sent).toEqual(
    expect.objectContaining({
      text: 'Summarise my week\nin three bullets',
      attachmentIds: [expect.any(String)],
      llmModelId: uuidFor(testInfo.project.name, 'model'),
    })
  );
  await expect(dialog).toHaveCount(0);
});

test('closing quick chat without sending leaves no empty chat behind', async ({ page }) => {
  await fakePlatform(page, 'Win32');
  const empty = () =>
    client
      .query(
        `SELECT count(*)::int AS n FROM chats WHERE owner_subject = $1 AND last_message_at IS NULL`,
        [subject]
      )
      .then((result) => result.rows[0].n);
  const before = await empty();
  await page.goto(`/agents`);
  const dialog = page.getByRole('dialog', { name: 'New chat' });
  await expect(async () => {
    await page.keyboard.press('c');
    await expect(dialog.getByLabel('Message')).toBeVisible({ timeout: 2500 });
  }).toPass({ timeout: 20_000, intervals: [2500] });
  await expect.poll(empty).toBe(before + 1);
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect.poll(empty).toBe(before);
});

test('chords use the Command key on a Mac, and quick chat works at phone width', async ({
  page,
}, testInfo) => {
  await fakePlatform(page, 'MacIntel');
  await page.setViewportSize(MOBILE_VIEWPORT);
  await page.goto(`/agents`);
  const switcher = page.getByRole('dialog', { name: 'Recent chats' });
  await pressUntilOpen(page, 'Meta+j', switcher);
  await page.keyboard.press('Escape');
  await expect(switcher).toHaveCount(0);
  // Control+J is not the Mac chord.
  await page.keyboard.press('Control+j');
  await page.waitForTimeout(300);
  await expect(switcher).toHaveCount(0);

  // Option is the Mac's Alt: ⌥ H is Home.
  await pressUntil(page, ['Alt+h'], () => expect(page).toHaveURL(/\/$/, { timeout: 1500 }));

  await page.keyboard.press('c');
  const dialog = page.getByRole('dialog', { name: 'New chat' });
  await expect(dialog.getByLabel('Message')).toBeVisible({ timeout: 20_000 });
  const panel = await dialog.locator('> div').boundingBox();
  expect(panel!.x).toBeGreaterThanOrEqual(0);
  expect(panel!.x + panel!.width).toBeLessThanOrEqual(MOBILE_VIEWPORT.width);
  await dialog.getByLabel('Message').fill('Draft a reply to the vendor about the delayed invoice');
  await shot(page, testInfo, 'shortcuts-quick-chat-phone');
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
});

test('the `c` key stands down in a field and over a dialog', async ({ page }) => {
  await fakePlatform(page, 'Win32');
  await page.goto(`/agents`);
  const quick = page.getByRole('dialog', { name: 'New chat' });
  const switcher = page.getByRole('dialog', { name: 'Recent chats' });

  // Over a dialog the bare key does nothing.
  await pressUntilOpen(page, 'Control+j', switcher);
  await page.keyboard.press('c');
  await page.waitForTimeout(300);
  await expect(quick).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(switcher).toHaveCount(0);

  // In a text field it is just a letter.
  const search = page.getByRole('searchbox', { name: 'Search Renkei' });
  await search.click();
  await page.keyboard.type('chat c');
  await page.waitForTimeout(800);
  await expect(search).toHaveValue('chat c');
  await expect(page.getByRole('dialog')).toHaveCount(0);

  // Held with a modifier it is not the shortcut either.
  await page.keyboard.press('Escape');
  await search.blur();
  await page.keyboard.press('Alt+c');
  await page.waitForTimeout(300);
  await expect(quick).toHaveCount(0);
});

test('the page chords work from a text field, with Alt on Windows and Linux', async ({ page }) => {
  test.setTimeout(120_000);
  await fakePlatform(page, 'Win32');
  await page.goto(`/agents`);
  const search = page.getByRole('searchbox', { name: 'Search Renkei' });
  await search.click();

  const to = (keys: string, url: RegExp) =>
    pressUntil(page, [keys], () => expect(page).toHaveURL(url, { timeout: 1500 }));
  await to('Alt+p', /\/chat\/projects$/);
  await to('Alt+a', /\/chat\/artifacts$/);
  await to('Alt+Shift+1', /\/notifications$/);
  await to('Alt+,', /\/preferences$/);
  await to('Control+Shift+/', /\/tutorials$/);
  await to('Control+`', /\/code$/);
  await to('Alt+h', /\/$/);
  await to('Control+Alt+Shift+,', /\/admin$/);
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
  await pressUntilOpen(page, 'Control+j', dialog);
  const options = dialog.getByRole('option');
  await expect(options.nth(0)).toContainText('Quarterly report draft');
  await expect(options.nth(0)).toContainText('Current');
  // On a chat, the switcher opens on the one before it.
  await expect(options.nth(1)).toHaveAttribute('aria-selected', 'true');
  await expect(options.nth(1)).toContainText('Expense policy question');
  await shot(page, testInfo, 'shortcuts-switcher');

  // Again moves on; Shift goes back.
  await page.keyboard.press('Control+j');
  await expect(options.nth(2)).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('Control+Shift+J');
  await expect(options.nth(1)).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('ArrowDown');
  await expect(options.nth(2)).toHaveAttribute('aria-selected', 'true');

  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(new RegExp(`/chat/${oldest}$`));
  await expect(dialog).toHaveCount(0);

  // From a page that is not a chat, it opens on the most recent one.
  await page.goto(`/agents`);
  await pressUntilOpen(page, 'Control+j', dialog);
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
  await expect(card).toHaveAttribute('data-coach-step', 'new-chat');
  await expect(card).toContainText('Press C anywhere');

  await card.getByRole('button', { name: 'Next' }).click();
  await expect(card).toHaveAttribute('data-coach-step', 'switch-chat');
  await expect(card).toContainText('⌘ J');
  await page.waitForTimeout(350);
  await shot(page, testInfo, 'shortcuts-coach-3-switch');

  await card.getByRole('button', { name: 'Next' }).click();
  await expect(card).toHaveAttribute('data-coach-step', 'go-to');
  await expect(card).toContainText('⌥ H');
  await expect(card).toContainText('⌥ ,');
  await page.waitForTimeout(350);
  await shot(page, testInfo, 'shortcuts-coach-4-go-to');

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
