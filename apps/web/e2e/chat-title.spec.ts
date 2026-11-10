/**
 * chat_rename end to end: the person asks, the scripted stand-in model
 * (e2e/support/stub-model.ts) calls chat_rename, the app's own tool
 * renames the chat, and the new title shows in the heading and the
 * sidebar on the real server.
 *
 * That the rename reads as an ordinary call in the reply's fold (not a
 * card), with its pencil and its line, is message-list.model.test.ts's;
 * renaming from the title bar (the field, Escape, an empty or unchanged
 * name) is chat-title.model.test.ts's; the automatic first-prompt title is
 * lib/chat/titles.test.ts's.
 */

import { randomUUID } from 'node:crypto';
import { test, expect } from './fixtures';
import { addStubModel, toolStep, removeModel, scripted } from './support/stub-model';
import { createChat, send } from './support/chat';

// Adding a model to the roster is an operator's.
test.use({ roles: ['renkei-user', 'renkei-operator'] });

const PROMPT = 'Call this chat something about the budget review.';

test('chat rename: the new title the tool wrote shows in the heading and the sidebar', async ({
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
    await expect(page.getByText(PROMPT).filter({ visible: true }).first()).toBeVisible();
    await expect(
      page.getByRole('navigation', { name: 'Chats' }).getByRole('link', { name: title })
    ).toBeVisible();
    await expect(page.getByText('Done — this chat is now called')).toBeVisible();
  } finally {
    await removeModel(page.request, modelId);
  }
});
