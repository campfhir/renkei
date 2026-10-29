/**
 * The browser's timezone rides along with every prompt (lib/chat/client.ts)
 * so the model reads "today" in the person's day instead of guessing a zone
 * from an office address. The browser is put in Los Angeles; the send is
 * caught with page.route — no model runs — and answered with a refusal the
 * thread shows, so the test sees both what went out and that the page
 * handled the reply.
 */

import { randomUUID } from 'node:crypto';
import { test, expect } from './fixtures';
import { addStubModel, removeModel } from './support/stub-model';
import { createChat } from './support/chat';

// Adding a model to the roster is an operator's.
test.use({ roles: ['renkei-user', 'renkei-operator'], timezoneId: 'America/Los_Angeles' });

test("a send carries the browser's timezone", async ({ page, person: _person }, testInfo) => {
  const tag = `${testInfo.project.name}-${randomUUID().slice(0, 6)}`;
  const title = `What day is it there? ${tag}`;
  // A model, so the composer is enabled; it is never called.
  const modelId = await addStubModel(page.request, tag);
  try {
    const chatId = await createChat(page.request, { llmModelId: modelId, title });
    const sent: unknown[] = [];
    await page.route(`**/api/chat/chats/${chatId}/turns`, async (route) => {
      if (route.request().method() !== 'POST') return route.fallback();
      sent.push(route.request().postDataJSON());
      await route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ code: 'e2e', error: 'Held back by the test.' }),
      });
    });

    await page.goto(`/chat/${chatId}`);
    await expect(page.getByRole('heading', { name: title })).toBeVisible({ timeout: 30_000 });
    const composer = page.getByRole('main').getByPlaceholder('Message Renkei');
    await composer.fill('What is my timezone?');
    await composer.press('Enter');

    await expect(page.getByText('Held back by the test.')).toBeVisible();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      text: 'What is my timezone?',
      timeZone: 'America/Los_Angeles',
    });
  } finally {
    await removeModel(page.request, modelId);
  }
});
