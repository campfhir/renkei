/**
 * The app menu's chat list picks up what happened while the page was in
 * the background. On a phone a backgrounded tab is frozen, so the reply that
 * finished in another app never reached the chat thread's refresh; coming
 * back to the tab (or restoring it from the back-forward cache) must re-read
 * the list.
 *
 * The chat is staged through the routes the composer calls, after the page
 * has loaded, so the menu is stale until the return. The return is simulated
 * by dispatching the browser's own events on the document.
 */

import { randomUUID } from 'node:crypto';
import { test, expect } from './fixtures';
import { addStubModel, removeModel } from './support/stub-model';
import { createChat, send } from './support/chat';

// A phone: the drawer is the menu, and the column beside the page is hidden.
// Adding a model to the roster is an operator's.
test.use({ viewport: { width: 390, height: 844 }, roles: ['renkei-user', 'renkei-operator'] });

async function openDrawer(page: import('@playwright/test').Page) {
  await page.getByRole('button', { name: 'Open menu' }).click();
  return page.getByRole('navigation', { name: 'Application' });
}

for (const [name, dispatch] of [
  [
    'visibilitychange',
    (page: import('@playwright/test').Page) =>
      page.evaluate(() => document.dispatchEvent(new Event('visibilitychange'))),
  ],
  [
    'pageshow from the back-forward cache',
    (page: import('@playwright/test').Page) =>
      page.evaluate(() =>
        window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }))
      ),
  ],
] as const) {
  test(`app menu: a chat finished while the tab was away shows on return (${name})`, async ({
    page,
    person: _person,
  }, testInfo) => {
    const tag = `${testInfo.project.name}-${randomUUID().slice(0, 6)}`;
    const title = `Return e2e ${tag}`;
    const modelId = await addStubModel(page.request, tag);
    try {
      await page.goto('/agents');
      const menu = await openDrawer(page);
      const chats = menu.getByRole('navigation', { name: 'Chats' });
      await expect(chats).toBeVisible();
      await expect(chats.getByRole('link', { name: title })).toHaveCount(0);

      // The reply lands while the page is "away": the menu still shows the old list.
      const chatId = await createChat(page.request, { llmModelId: modelId, title });
      await send(page.request, chatId, 'Hello.', modelId);
      await expect(chats.getByRole('link', { name: title })).toHaveCount(0);

      // Back to the tab: the list re-reads itself.
      await dispatch(page);
      await expect(chats.getByRole('link', { name: title })).toBeVisible();
    } finally {
      await removeModel(page.request, modelId);
    }
  });
}
