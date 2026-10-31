/**
 * A reply's Copy: the prose alone, and — behind the chevron beside it, only
 * on a reply that called tools — the same copy with each call's input and
 * result between the prose (lib/chat/copy-text.ts). The turn really runs:
 * the scripted stand-in model calls chat_rename, then answers.
 */

import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { test, expect } from './fixtures';
import { LLM_STUB_REPLY } from './constants';
import { addStubModel, toolStep, removeModel, scripted } from './support/stub-model';
import { createChat, send } from './support/chat';

// Adding a model to the roster is an operator's.
test.use({ roles: ['renkei-user', 'renkei-operator'] });

const PROMPT = 'Rename this chat, then tell me.';

test('chat copy: text by default, tool calls from the split menu', async ({
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
    // A second turn past the script: a plain reply, no calls.
    await send(page.request, chatId, 'And now just say hi.', modelId);

    await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.goto(`/chat/${chatId}`);
    const main = page.getByRole('main');
    await expect(main.getByText(done)).toBeVisible();
    await expect(main.getByText(LLM_STUB_REPLY)).toBeVisible();
    const clipboard = () => page.evaluate(() => navigator.clipboard.readText());

    // Only the reply that called a tool offers the chevron.
    const more = main.getByRole('button', { name: 'More copy options' });
    await expect(more).toHaveCount(1);

    // Plain Copy on that reply: the prose, no call.
    await main.getByText(done).hover();
    const copies = main.getByRole('button', { name: 'Copy', exact: true });
    await expect(copies).toHaveCount(2);
    await copies.first().click();
    await expect.poll(clipboard).toBe(done);

    // The menu: the call's name, input and result, then the prose.
    await more.click();
    const menu = main.getByRole('menu');
    await expect(menu.getByRole('menuitem', { name: 'Copy text only' })).toBeVisible();
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
    await expect(menu).toBeHidden();
    await expect.poll(clipboard).toContain('Tool call: chat_rename');
    const full = await clipboard();
    expect(full).toContain(`"title": "${title}"`);
    expect(full).toMatch(/Result:\n```\n.*Renamed the chat to/);
    expect(full.endsWith(done)).toBe(true);

    // Text only from the menu is the plain copy again.
    await more.click();
    await menu.getByRole('menuitem', { name: 'Copy text only' }).click();
    await expect.poll(clipboard).toBe(done);

    // The plain reply's Copy is just its text.
    await copies.last().click();
    await expect.poll(clipboard).toBe(LLM_STUB_REPLY);

    // Phone width: the row is always shown, the menu still opens.
    await page.setViewportSize({ width: 390, height: 844 });
    await more.click();
    await expect(menu.getByRole('menuitem', { name: 'Copy with tool calls' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(menu).toBeHidden();
  } finally {
    await removeModel(page.request, modelId);
  }
});
