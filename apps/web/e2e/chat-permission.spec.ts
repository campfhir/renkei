/**
 * A chat parked behind a tool call, on the real server: the thread draws
 * the ask inline, Always allow (behind the Allow button's arrow) lets the
 * runner carry on, and Preferences › Tool permissions then shows the tool
 * allowed and saves a change; Block in this chat (behind Deny's arrow)
 * sends its answer and leaves the person's own lists alone. The
 * notification the ask raised opens the chat in the same tab.
 *
 * The turn really runs: the scripted stand-in model (e2e/support/stub-model.ts)
 * calls chat_memory_remember — one of the chat's own tools that acts, so the
 * runner parks on it — and, once allowed, answers.
 *
 * The card's rules (its words for the owner and for anyone else, what it
 * will send, the buttons off and "Allowing…" while an answer is on its
 * way, a refusal shown) and the fold's "Waiting for permission" line are
 * message-list.model.test.ts's; the Preferences form's (a fold's "1
 * allowed, 1 blocked", "all", Save on only when something changed) are
 * preferences/tool-permissions-form.model.test.ts's; the route's (Always
 * allow stored, the ask's notification read, a second answer a 409, owner
 * only, Save replacing both lists) are
 * app/api/chat/chats/[chatId]/turns/[turnId]/permission/route.test.ts's.
 */

import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { APIRequestContext, Page, TestInfo } from '@playwright/test';
import { test, expect } from './fixtures';
import { addStubModel, toolStep, removeModel, scripted } from './support/stub-model';
import { createChat, readChat, startTurn } from './support/chat';

// Adding a model to the roster is an operator's.
test.use({ roles: ['renkei-user', 'renkei-operator'] });

const PROMPT = 'Remember that OPS-41 carries over to the next sprint with the same owner.';
const NOTE = 'OPS-41, Rotate the Zoom webhook secret, carries over with the same owner.';
const TOOL = 'chat_memory_remember';

interface Parked {
  chatId: string;
  turnId: string;
  toolUseId: string;
  title: string;
  modelId: string;
}

/** A chat whose running turn is parked behind chat_memory_remember. */
async function parkedChat(request: APIRequestContext, testInfo: TestInfo): Promise<Parked> {
  const tag = `${testInfo.project.name}-${randomUUID().slice(0, 6)}`;
  const title = `File the slipped issues ${tag}`;
  const modelId = await addStubModel(request, tag);
  const chatId = await createChat(request, { llmModelId: modelId, title });
  const turnId = await startTurn(
    request,
    chatId,
    scripted(PROMPT, [
      toolStep(TOOL, { note: NOTE }, 'On it — a note so the next sprint starts with it.'),
      { text: 'Noted for next time.' },
    ]),
    modelId
  );
  let toolUseId = '';
  await expect
    .poll(
      async () => {
        const ask = (await readChat(request, chatId)).chat.activeTurn?.pendingPermission;
        toolUseId = ask?.toolUseId ?? '';
        return ask?.name ?? null;
      },
      { timeout: 30_000 }
    )
    .toBe(TOOL);
  return { chatId, turnId, toolUseId, title, modelId };
}

async function shot(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  await page.screenshot({
    path: path.join(
      import.meta.dirname,
      '..',
      'test-results',
      'screens',
      testInfo.project.name,
      name
    ),
    fullPage: true,
  });
}

async function toolPermissions(request: APIRequestContext): Promise<unknown> {
  const response = await request.get('/api/chat/tool-permissions');
  expect(response.ok()).toBe(true);
  return response.json();
}

interface FeedItem {
  id: string;
  kind: string;
  refUrl: string | null;
  readAt: string | null;
}

async function permissionNotification(
  request: APIRequestContext,
  chatId: string
): Promise<FeedItem | null> {
  const response = await request.get('/api/notifications');
  expect(response.ok()).toBe(true);
  const body: { notifications: FeedItem[] } = await response.json();
  return (
    body.notifications.find(
      (item) => item.kind === 'chat_permission' && item.refUrl === `/chat/${chatId}`
    ) ?? null
  );
}

test('a parked turn shows the ask inline, and Always allow lands on the Preferences page', async ({
  page,
  person: _person,
}, testInfo) => {
  const parked = await parkedChat(page.request, testInfo);
  try {
    await page.goto(`/chat/${parked.chatId}`);
    await expect(page.getByRole('heading', { level: 1, name: parked.title })).toBeVisible();

    // The card, drawn where the reply stopped; Stop is still there.
    const card = page.getByRole('group', { name: 'Permission needed' });
    await expect(card.getByText('Allow this?')).toBeVisible();
    await expect(page.getByRole('button', { name: /stop/i })).toBeVisible();
    await shot(page, testInfo, 'chat-permission-ask.png');

    // Always allow, from the Allow button's arrow: the answer reaches the
    // turn, the runner carries on, the card goes.
    await card.getByRole('button', { name: 'More ways to allow' }).click();
    await shot(page, testInfo, 'chat-permission-allow-menu.png');
    await card.getByRole('menuitem', { name: /^Always allow/ }).click();
    await expect(page.getByText('Noted for next time.')).toBeVisible({ timeout: 15_000 });
    await expect(card).toBeHidden();

    // Preferences › Tool permissions shows the decision in the chat's own fold.
    await page.goto(`/preferences/permissions`);
    const section = page.getByRole('region', { name: 'What a chat may do' });
    await expect(section).toBeVisible();
    const own = section.locator('details', { hasText: 'The chat itself' }).first();
    await expect(own.locator('summary')).toContainText('1 allowed');
    await own.locator('summary').click();
    await expect(own.getByRole('radio', { name: `${TOOL}) — Allow`, exact: false })).toBeChecked();
    await section.scrollIntoViewIfNeeded();
    await shot(page, testInfo, 'preferences-tool-permissions.png');

    // One Save end to end: block a tool, and the stored lists say so.
    await own.getByRole('radio', { name: 'chat_memory_forget) — Block', exact: false }).check();
    await section.getByRole('button', { name: 'Save' }).click();
    await expect(section.getByText('Saved.')).toBeVisible();
    await expect
      .poll(() => toolPermissions(page.request))
      .toEqual({ alwaysAllow: [TOOL], alwaysDeny: ['chat_memory_forget'] });

    // The system-notification click preference sits with the other switches.
    await page.goto(`/preferences/notifications`);
    await expect(
      page.getByRole('checkbox', { name: /Open the notification.s own application/ })
    ).toBeChecked();
  } finally {
    await removeModel(page.request, parked.modelId);
  }
});

test('Block in this chat refuses the call and keeps it out of the chat, until Reset in its Tools dialog', async ({
  page,
  person: _person,
}, testInfo) => {
  // Two turns, a dialog and a reset: longer than one ask.
  test.setTimeout(120_000);
  const parked = await parkedChat(page.request, testInfo);
  try {
    await page.goto(`/chat/${parked.chatId}`);
    const card = page.getByRole('group', { name: 'Permission needed' });
    await expect(card.getByText('Allow this?')).toBeVisible();

    await card.getByRole('button', { name: 'More ways to deny' }).click();
    const menu = card.getByRole('menu', { name: 'Deny' });
    await expect(menu.getByRole('menuitem')).toHaveText([/^Block in this chat/, /^Block always/]);
    const answered = page.waitForRequest(
      (request) => request.method() === 'POST' && request.url().endsWith('/permission')
    );
    await menu.getByRole('menuitem', { name: /^Block in this chat/ }).click();
    expect((await answered).postDataJSON()).toMatchObject({ decision: 'deny-chat' });
    await expect(card).toBeHidden({ timeout: 15_000 });

    // Kept on this chat alone: the person's own lists are untouched.
    expect(await toolPermissions(page.request)).toEqual({ alwaysAllow: [], alwaysDeny: [] });

    // Taken back from the chat's Tools dialog: Reset sends "ask" for the tool.
    await page.getByRole('button', { name: 'Tools', exact: true }).click();
    const decided = page.getByRole('region', { name: 'Permissions' });
    await expect(decided).toContainText('Blocked here');
    await shot(page, testInfo, 'chat-tools-decided.png');
    const reset = page.waitForRequest(
      (request) => request.method() === 'PUT' && request.url().endsWith('/tool-answers')
    );
    await decided.getByRole('button', { name: new RegExp(`^Reset .*\\(${TOOL}\\)$`) }).click();
    expect((await reset).postDataJSON()).toEqual({ tool: TOOL, rule: 'clear', scope: 'chat' });
    await expect(decided.getByRole('button', { name: 'Blocked here' })).toBeHidden();
    await page.keyboard.press('Escape');

    // The next call to the tool in this chat asks again.
    await expect
      .poll(
        async () => (await readChat(page.request, parked.chatId)).chat.activeTurn?.status ?? null,
        {
          timeout: 30_000,
        }
      )
      .toBeNull();
    const again = await startTurn(
      page.request,
      parked.chatId,
      scripted(PROMPT, [
        toolStep(TOOL, { note: NOTE }, 'Trying again.'),
        { text: 'Noted for next time.' },
      ]),
      parked.modelId
    );
    await expect
      .poll(
        async () =>
          (await readChat(page.request, parked.chatId)).chat.activeTurn?.pendingPermission?.name ??
          null,
        { timeout: 30_000 }
      )
      .toBe(TOOL);
    await page.reload();
    await expect(card.getByText('Allow this?')).toBeVisible({ timeout: 30_000 });
    await page.request.post(`/api/chat/chats/${parked.chatId}/turns/${again}/cancel`);
  } finally {
    await page.request.post(`/api/chat/chats/${parked.chatId}/turns/${parked.turnId}/cancel`);
    await removeModel(page.request, parked.modelId);
  }
});

test('a reading tool, which never asks, can be blocked from the chat’s Tools dialog', async ({
  page,
  person: _person,
}, testInfo) => {
  const tag = `${testInfo.project.name}-${randomUUID().slice(0, 6)}`;
  const modelId = await addStubModel(page.request, tag);
  try {
    const chatId = await createChat(page.request, { llmModelId: modelId, title: `Reads ${tag}` });
    await page.goto(`/chat/${chatId}`);
    await page.getByRole('button', { name: 'Tools', exact: true }).click();
    const permissions = page.getByRole('region', { name: 'Permissions' });
    await expect(permissions).toContainText('Anything not listed asks first.');

    // Its own small dialog: search, pick one, what it may do, Save.
    await permissions.getByRole('button', { name: 'Set a tool' }).click();
    const blockDialog = page.getByRole('dialog', { name: 'Set a tool' });
    await blockDialog.getByLabel('Search tools').fill('chat_memory_list');
    await blockDialog.getByRole('radio', { name: /\(chat_memory_list\)$/ }).check();
    // A reading tool: this chat can make it ask, or block it.
    await blockDialog.getByText('Block', { exact: true }).click();
    const blocked = page.waitForRequest(
      (request) => request.method() === 'PUT' && request.url().endsWith('/tool-answers')
    );
    await blockDialog.getByRole('button', { name: 'Save' }).click();
    expect((await blocked).postDataJSON()).toEqual({
      tool: 'chat_memory_list',
      rule: 'deny',
      scope: 'chat',
    });
    await expect(blockDialog).toBeHidden();

    // Listed now; pressing its tag floats what it means beside it.
    const tagButton = permissions.getByRole('button', { name: 'Blocked here' });
    await expect(tagButton).toBeVisible();
    await tagButton.click();
    await expect(page.getByRole('tooltip')).toHaveText(/Refused in this chat/);
    await shot(page, testInfo, 'chat-tools-permissions.png');
  } finally {
    await removeModel(page.request, modelId);
  }
});

test('the permission notification opens the chat in the same tab', async ({
  page,
  person: _person,
}, testInfo) => {
  const parked = await parkedChat(page.request, testInfo);
  try {
    await page.goto(`/notifications`);
    const link = page.getByRole('link', {
      name: `“${parked.title}” is waiting for your permission`,
    });
    await expect(link.first()).toBeVisible();
    await expect(link.first()).toHaveAttribute('href', `/chat/${parked.chatId}`);
    await expect(link.first()).not.toHaveAttribute('target', '_blank');
    await shot(page, testInfo, 'notifications-chat-permission.png');

    // The banner's click path: the open route marks the row read and lands
    // in the chat (an in-app link, whatever the source-app preference says).
    const notification = await permissionNotification(page.request, parked.chatId);
    expect(notification).not.toBeNull();
    const opened = await page.request.get(`/api/notifications/${notification?.id}/open`, {
      maxRedirects: 0,
    });
    expect(opened.status()).toBe(302);
    expect(opened.headers()['location']).toContain(`/chat/${parked.chatId}`);
    expect((await permissionNotification(page.request, parked.chatId))?.readAt).not.toBeNull();
  } finally {
    await page.request.post(`/api/chat/chats/${parked.chatId}/turns/${parked.turnId}/cancel`);
    await removeModel(page.request, parked.modelId);
  }
});
