/**
 * A chat parked behind a tool call: the turn carries the ask and the
 * thread shows it inline — the card with Allow once / Always allow /
 * Deny, the fold's "Waiting for permission" line. Answering lets the
 * runner carry on, and puts "always" on the person's list, which the
 * Preferences page then shows with a way to take it back. The
 * notification the ask raised is opened from the feed in the same tab.
 *
 * The turn really runs: the scripted stand-in model (e2e/support/stub-model.ts)
 * calls chat_memory_remember — one of the chat's own tools that acts, so the
 * runner parks on it — and, once allowed, answers.
 */

import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { APIRequestContext, Page, TestInfo } from '@playwright/test';
import { test, expect } from './fixtures';
import { addStubModel, removeModel } from '../support/stub-model';
import { createChat, readChat, startTurn } from '../support/chat';

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
  const modelId = await addStubModel(request, tag, {
    script: [
      {
        when: PROMPT,
        steps: [
          {
            text: 'On it — a note so the next sprint starts with it.',
            tools: [{ name: TOOL, input: { note: NOTE } }],
          },
          { text: 'Noted for next time.' },
        ],
      },
    ],
  });
  const chatId = await createChat(request, { llmModelId: modelId, title });
  const turnId = await startTurn(request, chatId, PROMPT, modelId);
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

test('a parked turn shows the ask inline, and Always allow records the tool', async ({
  page,
  person: _person,
}, testInfo) => {
  const parked = await parkedChat(page.request, testInfo);
  try {
    await page.goto(`/chat/${parked.chatId}`);
    await expect(page.getByRole('heading', { level: 1, name: parked.title })).toBeVisible();

    // The fold says what the turn is waiting on, and the card carries the
    // three answers plus what the call would send.
    await expect(page.getByText('Waiting for permission to call').first()).toBeVisible();
    const card = page.getByRole('group', { name: 'Permission needed' });
    await expect(card).toBeVisible();
    await expect(card.getByText('Allow this?')).toBeVisible();
    await expect(card.getByRole('button', { name: 'Allow once' })).toBeVisible();
    await expect(card.getByRole('button', { name: 'Always allow' })).toBeVisible();
    await expect(card.getByRole('button', { name: 'Deny' })).toBeVisible();
    await card.getByText('What it will send').click();
    await expect(card.getByText(/Rotate the Zoom webhook secret/)).toBeVisible();
    // Stop is still there: a parked turn can be cancelled.
    await expect(page.getByRole('button', { name: /stop/i })).toBeVisible();
    await shot(page, testInfo, 'chat-permission-ask.png');

    // Always allow: the turn carries on, the person's list gets the tool.
    await card.getByRole('button', { name: 'Always allow' }).click();
    await expect(page.getByText('Noted for next time.')).toBeVisible({ timeout: 15_000 });
    await expect(card).toBeHidden();
    await expect
      .poll(() => toolPermissions(page.request), { timeout: 10_000 })
      .toEqual({ alwaysAllow: [TOOL], alwaysDeny: [] });
    // ...and the notification the ask raised is read.
    await expect
      .poll(async () => (await permissionNotification(page.request, parked.chatId))?.readAt ?? null)
      .not.toBeNull();

    // A second answer is refused: the turn is no longer waiting on it.
    const again = await page.request.post(
      `/api/chat/chats/${parked.chatId}/turns/${parked.turnId}/permission`,
      { data: { toolUseId: parked.toolUseId, decision: 'deny' } }
    );
    expect(again.status()).toBe(409);
    expect(await toolPermissions(page.request)).toEqual({ alwaysAllow: [TOOL], alwaysDeny: [] });

    // Preferences shows the decision in the chat's own fold — Allow for the
    // tool just allowed — with Ask and Block beside it, and the system-
    // notification click preference sits with the other switches.
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

    // Block a tool that has never been called, so the chat never sees it.
    await own.getByRole('radio', { name: 'chat_memory_forget) — Block', exact: false }).check();
    await expect(own.locator('summary')).toContainText('1 allowed, 1 blocked');
    await section.scrollIntoViewIfNeeded();
    await shot(page, testInfo, 'preferences-tool-permissions.png');

    // Back to asking for the allowed one; the block stays.
    await own.getByRole('radio', { name: `${TOOL}) — Ask`, exact: false }).check();
    await section.getByRole('button', { name: 'Save' }).click();
    await expect(section.getByText('Saved.')).toBeVisible();
    await expect
      .poll(() => toolPermissions(page.request))
      .toEqual({ alwaysAllow: [], alwaysDeny: ['chat_memory_forget'] });
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
