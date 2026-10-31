/**
 * The composer's unsent text, kept per chat on the server
 * (lib/chat/drafts.ts): typing is saved once after a pause — not per
 * keystroke — and comes back after a reload and in a second browser
 * context (another device) with the same sign-in. Clearing the box
 * removes it. What is stored is read back the way the page reads it, as
 * the chat's `draft` (GET /api/chat/chats/:id); that it is sealed at rest
 * is lib/chat/drafts.ts's own tests' to show.
 *
 * "Another device" is a fresh browser context carrying the same session
 * cookie; "phone width" is a resized viewport (see AGENTS.md's "UI
 * changes"). The chat is the test's own person's.
 */

import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { Page, TestInfo } from '@playwright/test';
import { test, expect } from './fixtures';
import { addStubModel, removeModel } from './support/stub-model';
import { createChat, readChat } from './support/chat';

const MOBILE_VIEWPORT = { width: 390, height: 844 };
const DRAFT = 'Remind me which endpoint posts refunds, and who owns it';

// Adding a model to the roster is an operator's.
test.use({ roles: ['renkei-user', 'renkei-operator'] });

let modelId = '';
let chatId = '';

test.beforeEach(async ({ page, person: _person }, testInfo) => {
  const tag = `${testInfo.project.name}-${randomUUID().slice(0, 6)}`;
  modelId = await addStubModel(page.request, tag);
  chatId = await createChat(page.request, { llmModelId: modelId, title: `Draft survives ${tag}` });
});

test.afterEach(async ({ page }) => {
  await removeModel(page.request, modelId);
});

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

async function openChat(page: Page): Promise<void> {
  await page.goto(`/chat/${chatId}`);
  await expect(page.getByLabel('Message').filter({ visible: true })).toBeVisible();
  await page.addStyleTag({ content: 'nextjs-portal { display: none !important; }' });
}

const isDraftSave = (url: string, method: string) =>
  method === 'PUT' && url.endsWith(`/api/chat/chats/${chatId}/draft`);

test('an unsent message is saved after a pause and comes back on reload', async ({
  page,
}, testInfo) => {
  await openChat(page);
  await expect(page.getByLabel('Message').filter({ visible: true })).toHaveValue('');

  const saves: string[] = [];
  page.on('request', (request) => {
    if (isDraftSave(request.url(), request.method())) saves.push(request.postData() ?? '');
  });
  const saved = page.waitForResponse(
    (response) => isDraftSave(response.url(), response.request().method()) && response.ok()
  );
  // Keystroke by keystroke, well inside the debounce window.
  await page
    .getByLabel('Message')
    .filter({ visible: true })
    .pressSequentially(DRAFT, { delay: 15 });
  await saved;
  expect(saves).toHaveLength(1);
  expect(JSON.parse(saves[0])).toEqual({ text: DRAFT });
  expect((await readChat(page.request, chatId)).chat.draft).toBe(DRAFT);

  await page.reload();
  await expect(page.getByLabel('Message').filter({ visible: true })).toHaveValue(DRAFT);
  await shot(page, testInfo, 'chat-draft-restored');
});

test('another device sees the draft, and clearing the box removes it', async ({
  page,
  browser,
}, testInfo) => {
  await openChat(page);
  const saved = page.waitForResponse(
    (response) => isDraftSave(response.url(), response.request().method()) && response.ok()
  );
  await page.getByLabel('Message').filter({ visible: true }).fill(DRAFT);
  await saved;

  // A second browser context with the same sign-in, at phone width.
  const state = await page.context().storageState();
  const phone = await browser.newContext({
    reducedMotion: 'reduce',
    storageState: state,
    viewport: MOBILE_VIEWPORT,
  });
  try {
    const other = await phone.newPage();
    await other.goto(`/chat/${chatId}`);
    await expect(other.getByLabel('Message').filter({ visible: true })).toBeVisible();
    await expect(other.getByLabel('Message').filter({ visible: true })).toHaveValue(DRAFT);
    await shot(other, testInfo, 'chat-draft-phone');

    // Clearing is saved at once and drops the draft.
    const cleared = other.waitForResponse(
      (response) => isDraftSave(response.url(), response.request().method()) && response.ok()
    );
    await other.getByLabel('Message').filter({ visible: true }).fill('');
    await cleared;
  } finally {
    await phone.close();
  }
  expect((await readChat(page.request, chatId)).chat.draft).toBe('');

  await page.reload();
  await expect(page.getByLabel('Message').filter({ visible: true })).toHaveValue('');
});
