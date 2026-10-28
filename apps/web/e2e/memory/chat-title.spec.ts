/**
 * chat_rename's place in the thread: a rename the person asked for is an
 * ordinary tool call — its own fold, its result, and the new title in the
 * heading and the sidebar. The turn really runs: the scripted stand-in
 * model (e2e/support/stub-model.ts) calls chat_rename, the app's own tool
 * renames the chat, and the model answers. The automatic first-prompt
 * title is covered by the unit tests in lib/chat/titles.test.ts.
 */

import { randomUUID } from 'node:crypto';
import { test, expect } from './fixtures';
import { addStubModel, toolStep, removeModel, scripted } from '../support/stub-model';
import { createChat, send } from '../support/chat';

// Adding a model to the roster is an operator's.
test.use({ roles: ['renkei-user', 'renkei-operator'] });

const PROMPT = 'Call this chat something about the budget review.';

test('chat rename: the tool call shows as an ordinary call, the new title sticks', async ({
  page,
  person: _person,
}, testInfo) => {
  const tag = `${testInfo.project.name}-${randomUUID().slice(0, 6)}`;
  const title = `Quarterly budget review ${tag}`;
  const modelId = await addStubModel(page.request, tag);
  try {
    const chatId = await createChat(page.request, { llmModelId: modelId });
    // The rename acts on the chat, so the turn asks first: allowed once, as the card would.
    const steps = [
      toolStep('chat_rename', { title }),
      { text: `Done — this chat is now called ${title}.` },
    ];
    await send(page.request, chatId, scripted(PROMPT, steps), modelId, { allow: true });

    await page.goto(`/chat/${chatId}`);
    await expect(page.getByRole('heading', { level: 1, name: title })).toBeVisible();
    await expect(page.getByText(PROMPT)).toBeVisible();
    await expect(
      page.getByRole('navigation', { name: 'Chats' }).getByRole('link', { name: title })
    ).toBeVisible();

    // The rename is a tool call in the thread like any other: a fold naming
    // it, inside the reply's work fold (as chat.spec.ts's tool call is).
    const work = page.locator('details.chat-fold', { hasText: /rename/i }).first();
    await expect(work).toBeVisible();
    await work.locator('> summary').click();
    const call = work.locator('details.chat-fold', { hasText: /rename/i }).first();
    await expect(call).toBeVisible();
    await call.locator('> summary').click();
    await expect(call.getByText(/Renamed the chat to/)).toBeVisible();
    await expect(page.getByText('Done — this chat is now called')).toBeVisible();
  } finally {
    await removeModel(page.request, modelId);
  }
});
