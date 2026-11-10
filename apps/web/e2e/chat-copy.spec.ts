/**
 * A reply's Copy reaching the real clipboard: the chevron's menu opens on a
 * reply that really called a tool (the scripted stand-in model calls
 * chat_rename, then answers), one pick puts the call and the prose on the
 * clipboard, and at phone width the menu still opens and Escape shuts it.
 *
 * What each copy holds is lib/chat/copy-text.test.ts's; which choices a
 * reply offers (no tool calls without calls, no context without a
 * prompt), "Copy text only" first, and the menu shutting on a pick are
 * message-list.model.test.ts's.
 */

import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { test, expect } from './fixtures';
import { addStubModel, toolStep, removeModel, scripted } from './support/stub-model';
import { createChat, send } from './support/chat';

// Adding a model to the roster is an operator's.
test.use({ roles: ['renkei-user', 'renkei-operator'] });

const PROMPT = 'Rename this chat, then tell me.';

test('chat copy: the split menu copies a reply with its tool calls to the clipboard', async ({
  page,
  person: _person,
}, testInfo) => {
  const tag = `${testInfo.project.name}-${randomUUID().slice(0, 6)}`;
  const title = `Copy check ${tag}`;
  const done = `Renamed it to ${title}.`;
  const modelId = await addStubModel(page.request, tag);
  try {
    const chatId = await createChat(page.request, { llmModelId: modelId });
    const steps = [toolStep('chat_rename', { title }), { text: done }];
    await send(page.request, chatId, scripted(PROMPT, steps), modelId, { allow: true });

    await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.goto(`/chat/${chatId}`);
    const main = page.getByRole('main');
    await expect(main.getByText(done)).toBeVisible();
    const clipboard = () => page.evaluate(() => navigator.clipboard.readText());

    // The menu, then one real copy: the call as the server ran it, then the prose.
    const more = main.getByRole('button', { name: 'More copy options' });
    await more.click();
    const menu = main.getByRole('menu');
    await expect(menu.getByRole('menuitem')).toHaveText([
      'Copy text only',
      'Copy with tool calls',
      'Copy with context',
    ]);
    await page.screenshot({
      path: path.join(
        import.meta.dirname,
        '..',
        'test-results',
        'screens',
        testInfo.project.name,
        'chat-copy-menu.png'
      ),
    });
    await menu.getByRole('menuitem', { name: 'Copy with tool calls' }).click();
    await expect.poll(clipboard).toContain('Tool call: chat_rename');
    const full = await clipboard();
    expect(full).toContain(`"title": "${title}"`);
    expect(full).toMatch(/Result:\n```\n.*Renamed the chat to/);
    expect(full.endsWith(done)).toBe(true);

    // Phone width: the row is always shown, the menu still opens, Escape shuts it.
    await page.setViewportSize({ width: 390, height: 844 });
    await more.click();
    await expect(menu).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(menu).toBeHidden();
  } finally {
    await removeModel(page.request, modelId);
  }
});
