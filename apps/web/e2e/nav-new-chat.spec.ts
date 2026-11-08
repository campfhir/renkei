/**
 * "+ New" makes its chat before anything is said in it, and the app menu
 * lists a chat only from its first message — out of the layout's server
 * data, which the thread re-reads the moment the first turn starts
 * (chat-thread.tsx; when, chat-thread.model.test.ts's). What stays here is
 * the path end to end in a browser: a prompt sent from the composer of a
 * fresh chat, the reply still being written, and the chat already in the
 * menu's list.
 */

import { randomUUID } from 'node:crypto';
import { test, expect } from './fixtures';
import { addStubModel, releaseStub, removeModel, scripted } from './support/stub-model';

// Adding a model to the roster is an operator's.
test.use({ roles: ['renkei-user', 'renkei-operator'] });

test('app menu: a new chat is listed as soon as its first message is sent', async ({
  page,
  person: _person,
}, testInfo) => {
  const tag = `${testInfo.project.name}-${randomUUID().slice(0, 6)}`;
  const hold = `new-chat-${tag}`;
  const modelId = await addStubModel(page.request, tag);
  try {
    // A desktop: the menu is the column beside the page.
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/chat/new');
    await expect(page).toHaveURL(/\/chat\/[0-9a-f-]{36}$/);
    const chatId = page.url().match(/\/chat\/([0-9a-f-]{36})$/)?.[1] ?? '';
    expect(chatId).not.toBe('');

    const column = page.locator('nav[aria-label="Application"]:visible').first();
    const list = column.getByRole('navigation', { name: 'Chats' });
    const row = list.locator(`a[href="/chat/${chatId}"]`);
    // Empty, the chat is not in the menu.
    await expect(list).toBeVisible();
    await expect(row).toHaveCount(0);

    // This spec's own model answers, and its reply waits on the test.
    await page.getByRole('button', { name: 'Model' }).click();
    await page.getByRole('menuitemradio', { name: new RegExp(`^Stub model ${tag}`) }).click();
    const box = page.getByRole('textbox', { name: 'Message' });
    await box.fill(scripted('Plan the launch week', [{ text: 'Here is the plan.', until: hold }]));
    await page.getByRole('button', { name: 'Send' }).click();

    // The prompt is in the thread, the reply is not yet — and the chat is
    // already in the menu, under the title derived from the prompt.
    await expect(page.getByRole('main').getByText(/Plan the launch week/).first()).toBeVisible();
    await expect(page.getByText('Here is the plan.')).toHaveCount(0);
    await expect(row).toBeVisible();
    await expect(row).toContainText('Plan the launch week');

    // The reply lands; the chat stays listed.
    await releaseStub(page.request, hold);
    await expect(page.getByText('Here is the plan.')).toBeVisible();
    await expect(row).toBeVisible();
  } finally {
    await removeModel(page.request, modelId);
  }
});
