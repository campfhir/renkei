/**
 * A temporary chat, end to end in a browser: the Temporary switch on an
 * empty chat's composer makes it one (kept across a reload, with the empty
 * state and the notice saying what it means), the menu tags it, and a
 * reply in it cannot keep a memory — the stub model calls
 * chat_memory_remember, which a temporary chat is not offered, so the call
 * is refused without a permission ask, the turn carries on, and the
 * person's memory stays empty.
 * After the first message the switch is gone, and the route refuses to
 * change it; a temporary chat cannot be started in, or moved into, a
 * project.
 *
 * The deletion after a quiet day is the worker's retention sweep
 * (apps/worker-agents/src/chat-sweep.ts, unit-tested there); the suite
 * runs no sweeps.
 *
 * The stub model is organization-wide: tagged per test and removed after.
 */

import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Page, TestInfo } from '@playwright/test';
import { createChat } from './support/chat';
import { addStubModel, removeModel, scripted, toolStep } from './support/stub-model';
import { test, expect } from './fixtures';

const RESULTS = path.join(import.meta.dirname, '..', 'test-results');
const MOBILE_VIEWPORT = { width: 390, height: 844 };
const NOTICE =
  'Temporary chat: it doesn’t read or save memories, and it is deleted 24 hours after its last activity.';

// Adding a model to the roster is an operator's.
test.use({ roles: ['renkei-user', 'renkei-operator'] });

async function shot(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  await page.screenshot({
    path: path.join(RESULTS, 'screens', testInfo.project.name, `${name}.png`),
    fullPage: true,
  });
}

test('a temporary chat keeps no memory and says so, and stays out of projects', async ({
  page,
  person: _person,
}, testInfo) => {
  const tag = `${testInfo.project.name}-${randomUUID().slice(0, 6)}`;
  const modelId = await addStubModel(page.request, tag);
  try {
    const chatId = await createChat(page.request, { llmModelId: modelId });
    await page.goto(`/chat/${chatId}`);
    const main = page.getByRole('main');

    // An ordinary empty chat: the switch is off, and nothing says temporary.
    const off = main.getByRole('button', { name: 'Temporary chat off' });
    await expect(off).toBeVisible();
    await expect(page.getByTestId('temporary-chat-notice')).toHaveCount(0);
    const saved = page.waitForResponse(
      (response) =>
        response.url().endsWith(`/api/chat/chats/${chatId}`) &&
        response.request().method() === 'PATCH'
    );
    await off.click();
    expect((await saved).ok()).toBe(true);

    // On: the empty state and the notice say what it means, and it holds.
    await expect(main.getByRole('button', { name: 'Temporary chat on' })).toHaveAttribute(
      'aria-pressed',
      'true'
    );
    await expect(main.getByText('Temporary chat', { exact: true })).toBeVisible();
    await expect(page.getByTestId('temporary-chat-notice')).toHaveText(NOTICE);
    await page.reload();
    await expect(main.getByRole('button', { name: 'Temporary chat on' })).toBeVisible();
    await shot(page, testInfo, 'chat-temporary-01-empty');

    // A reply that tries to keep a memory: the tool is not there to call.
    const box = main.getByRole('textbox', { name: 'Message' });
    await box.fill(
      scripted('Remember that my badge number is 4471.', [
        toolStep('chat_memory_remember', { note: 'Badge number 4471.' }, 'Making a note.'),
        { text: 'I can’t keep notes in a temporary chat.' },
      ])
    );
    await box.press('Enter');
    await expect(
      main.getByText('I can’t keep notes in a temporary chat.').filter({ visible: true })
    ).toBeVisible({ timeout: 30_000 });
    // Refused without asking: there was never a tool to allow.
    await expect(main.getByRole('group', { name: 'Permission needed' })).toHaveCount(0);
    const memory = await page.request.get('/api/chat/memory');
    expect(memory.ok()).toBe(true);
    const body: { entries: { content: string }[] } = await memory.json();
    expect(body.entries).toEqual([]);

    // Written in: the switch is gone, the notice stays, the menu tags it.
    await expect(main.getByRole('button', { name: /Temporary chat (on|off)/ })).toHaveCount(0);
    await expect(page.getByTestId('temporary-chat-notice')).toBeVisible();
    const row = page.locator(`a[href="/chat/${chatId}"]`).filter({ visible: true });
    await expect(row.getByText('temporary', { exact: true })).toBeVisible();
    await shot(page, testInfo, 'chat-temporary-02-replied');

    // And the route will not change it now, nor put it in a project.
    const late = await page.request.patch(`/api/chat/chats/${chatId}`, {
      data: { temporary: false },
    });
    expect(late.status()).toBe(409);
    const project = await page.request.post('/api/chat/projects', {
      data: { name: `Temporary spec ${tag}` },
    });
    expect(project.status(), await project.text()).toBe(201);
    const { projectId }: { projectId: string } = await project.json();
    const moved = await page.request.post(`/api/chat/chats/${chatId}/move`, {
      data: { projectId },
    });
    expect(moved.status()).toBe(400);
    const inProject = await page.request.post('/api/chat/chats', {
      data: { projectId, temporary: true },
    });
    expect(inProject.status()).toBe(400);

    // "New temporary chat" from the menu starts the next one as temporary.
    await main.getByRole('button', { name: 'More', exact: true }).click();
    await page.getByRole('menuitem', { name: 'New temporary chat' }).click();
    await expect(page).not.toHaveURL(new RegExp(`/chat/${chatId}$`));
    await expect(page).toHaveURL(/\/chat\/[0-9a-f-]{36}$/);
    await expect(main.getByRole('button', { name: 'Temporary chat on' })).toBeVisible();

    // Phone width: the notice and the switch fit.
    await page.setViewportSize(MOBILE_VIEWPORT);
    await expect(page.getByTestId('temporary-chat-notice')).toBeVisible();
    const fits = await page.evaluate(
      () => document.documentElement.scrollWidth <= document.documentElement.clientWidth
    );
    expect(fits).toBe(true);
    await shot(page, testInfo, 'chat-temporary-03-mobile');
  } finally {
    await removeModel(page.request, modelId);
  }
});
