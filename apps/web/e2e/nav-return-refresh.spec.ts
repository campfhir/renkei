/**
 * The app menu's chat list picks up what happened while the page was in
 * the background. On a phone a backgrounded tab is frozen, so the reply that
 * finished in another app never reached the chat thread's refresh; coming
 * back to the tab must re-read the list.
 *
 * When a return re-reads (visible again, or restored from the back-forward
 * cache; not while offline, not on an ordinary page load) and what the list
 * holds after it (the fresh window plus paged-in chats, the fresh copy
 * winning, the cursor not rewound) are chat-nav.model.test.ts's. What stays
 * here is the one path end to end in a browser: the browser's own event on
 * the document, the layout's data re-read from the real server, the new
 * chat drawn in the phone's drawer.
 *
 * The chat is staged through the routes the composer calls, after the page
 * has loaded, so the menu is stale until the return.
 */

import { randomUUID } from 'node:crypto';
import { test, expect } from './fixtures';
import { addStubModel, removeModel } from './support/stub-model';
import { createChat, send } from './support/chat';

// A phone: the drawer is the menu, and the column beside the page is hidden.
// Adding a model to the roster is an operator's.
test.use({ viewport: { width: 390, height: 844 }, roles: ['renkei-user', 'renkei-operator'] });

test('app menu: a chat finished while the tab was away shows on return', async ({
  page,
  person: _person,
}, testInfo) => {
  const tag = `${testInfo.project.name}-${randomUUID().slice(0, 6)}`;
  const title = `Return e2e ${tag}`;
  const modelId = await addStubModel(page.request, tag);
  try {
    await page.goto('/agents');
    await page.getByRole('button', { name: 'Open menu' }).click();
    const menu = page.getByRole('navigation', { name: 'Application' });
    const chats = menu.getByRole('navigation', { name: 'Chats' });
    await expect(chats).toBeVisible();
    await expect(chats.getByRole('link', { name: title })).toHaveCount(0);

    // The reply lands while the page is "away": the menu still shows the old list.
    const chatId = await createChat(page.request, { llmModelId: modelId, title });
    await send(page.request, chatId, 'Hello.', modelId);
    await expect(chats.getByRole('link', { name: title })).toHaveCount(0);

    // Back to the tab: the list re-reads itself.
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await expect(chats.getByRole('link', { name: title })).toBeVisible();
  } finally {
    await removeModel(page.request, modelId);
  }
});
