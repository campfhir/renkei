/**
 * A chat parked behind a tool call, on the real server: the thread draws
 * the ask inline, Always allow lets the runner carry on, and the
 * Preferences page then shows the tool allowed and saves a change. The
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

    // Always allow: the answer reaches the turn, the runner carries on, the card goes.
    await card.getByRole('button', { name: 'Always allow' }).click();
    await expect(page.getByText('Noted for next time.')).toBeVisible({ timeout: 15_000 });
    await expect(card).toBeHidden();

    // Preferences shows the decision in the chat's own fold, and the
    // system-notification click preference sits with the other switches.
    await page.goto(`/preferences`);
    const section = page.getByRole('region', { name: 'What a chat may do' });
    await expect(section).toBeVisible();
    await expect(
      page.getByRole('checkbox', { name: /Open the notification.s own application/ })
    ).toBeChecked();
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
  } finally {
    await removeModel(page.request, parked.modelId);
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
