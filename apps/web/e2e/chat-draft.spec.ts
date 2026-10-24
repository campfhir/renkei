/**
 * The composer's unsent text, kept per chat on the server
 * (lib/chat/drafts.ts): typing is saved once after a pause — not per
 * keystroke — and comes back after a reload and in a second browser
 * context (another device) with the same sign-in. The stored text is
 * sealed, and clearing the box removes the row.
 *
 * "Another device" is a fresh browser context carrying the same session
 * cookie; "phone width" is a resized Chromium viewport (see AGENTS.md's
 * "UI changes"). The chat row is this project's own, so the parallel
 * Playwright projects do not share a draft.
 */

import { test, expect, type Page } from '@playwright/test';
import { Client } from 'pg';
import { E2E_SUBJECT } from './seed';
import { MODEL_ID, seedVoice, shot } from './voice-fixtures';

const MOBILE_VIEWPORT = { width: 390, height: 844 };
const DRAFT = 'Remind me which endpoint posts refunds, and who owns it';

test.use({
  launchOptions: {
    executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    args: ['--no-sandbox'],
  },
});

function idsFor(project: string) {
  const digit = { 'desktop-light': '1', 'desktop-dark': '2', mobile: '3' }[project] ?? '4';
  return {
    chatId: `80808080-8080-4808-8808-8080808080${digit}1`,
    chatTitle: `Draft survives (${digit})`,
  };
}

async function withClient<T>(run: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    return await run(client);
  } finally {
    await client.end();
  }
}

test.beforeEach(async ({ browserName: _browser }, testInfo) => {
  const ids = idsFor(testInfo.project.name);
  await withClient(async (client) => {
    await seedVoice(client);
    await client.query('DELETE FROM chats WHERE id = $1', [ids.chatId]);
    await client.query(
      `INSERT INTO chats (id, owner_subject, title, llm_model_id, last_message_at)
       VALUES ($1, $2, $3, $4, NOW())`,
      [ids.chatId, E2E_SUBJECT, ids.chatTitle, MODEL_ID]
    );
  });
});

test.afterEach(async ({ browserName: _browser }, testInfo) => {
  await withClient((client) =>
    client.query('DELETE FROM chats WHERE id = $1', [idsFor(testInfo.project.name).chatId])
  );
});

async function openChat(page: Page, chatId: string): Promise<void> {
  await page.goto(`/chat/${chatId}`);
  await expect(page.getByLabel('Message')).toBeVisible();
  await page.addStyleTag({ content: 'nextjs-portal { display: none !important; }' });
}

const isDraftSave = (url: string, method: string, chatId: string) =>
  method === 'PUT' && url.endsWith(`/api/chat/chats/${chatId}/draft`);

test('an unsent message is saved after a pause and comes back on reload', async ({
  page,
}, testInfo) => {
  const { chatId } = idsFor(testInfo.project.name);
  await openChat(page, chatId);
  await expect(page.getByLabel('Message')).toHaveValue('');

  const saves: string[] = [];
  page.on('request', (request) => {
    if (isDraftSave(request.url(), request.method(), chatId)) saves.push(request.postData() ?? '');
  });
  const saved = page.waitForResponse(
    (response) => isDraftSave(response.url(), response.request().method(), chatId) && response.ok()
  );
  // Keystroke by keystroke, well inside the debounce window.
  await page.getByLabel('Message').pressSequentially(DRAFT, { delay: 15 });
  await saved;
  expect(saves).toHaveLength(1);
  expect(JSON.parse(saves[0])).toEqual({ text: DRAFT });

  // Sealed at rest: the plaintext is nowhere in the row.
  const stored = await withClient((client) =>
    client.query('SELECT content FROM chat_drafts WHERE chat_id = $1', [chatId])
  );
  expect(stored.rows).toHaveLength(1);
  expect(stored.rows[0].content).not.toContain('refunds');

  await page.reload();
  await expect(page.getByLabel('Message')).toHaveValue(DRAFT);
  await shot(page, testInfo, 'chat-draft-restored', false);
});

test('another device sees the draft, and clearing the box removes it', async ({
  page,
  browser,
}, testInfo) => {
  const { chatId } = idsFor(testInfo.project.name);
  await openChat(page, chatId);
  const saved = page.waitForResponse(
    (response) => isDraftSave(response.url(), response.request().method(), chatId) && response.ok()
  );
  await page.getByLabel('Message').fill(DRAFT);
  await saved;

  // A second browser context with the same sign-in, at phone width.
  const state = await page.context().storageState();
  const phone = await browser.newContext({ storageState: state, viewport: MOBILE_VIEWPORT });
  try {
    const other = await phone.newPage();
    await openChat(other, chatId);
    await expect(other.getByLabel('Message')).toHaveValue(DRAFT);
    await shot(other, testInfo, 'chat-draft-phone', false);

    // Clearing is saved at once and drops the row.
    const cleared = other.waitForResponse(
      (response) =>
        isDraftSave(response.url(), response.request().method(), chatId) && response.ok()
    );
    await other.getByLabel('Message').fill('');
    await cleared;
  } finally {
    await phone.close();
  }
  const rows = await withClient((client) =>
    client.query('SELECT 1 FROM chat_drafts WHERE chat_id = $1', [chatId])
  );
  expect(rows.rows).toHaveLength(0);

  await page.reload();
  await expect(page.getByLabel('Message')).toHaveValue('');
});
