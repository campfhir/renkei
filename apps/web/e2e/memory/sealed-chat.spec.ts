/**
 * A chat written the way the app writes one — created, renamed and asked
 * a question through the chat's own routes, the reply streamed by the
 * stand-in model (e2e/llm-stub.mjs) and sealed under the chat's key by the
 * turn engine — opens in the browser through the delegate the memory
 * server runs in-process: the person is really enrolled, their session
 * really delegated, and the page reads the question and the reply in the
 * clear.
 *
 * The model is staged through the admin roster's route, tagged and named
 * on the chat, and removed again afterwards: the roster is everybody's.
 */

import { randomUUID } from 'node:crypto';
import { test, expect } from './fixtures';
import { LLM_STUB_REPLY } from './constants';
import { addStubModel, removeModel } from '../support/stub-model';

const QUESTION = 'What slipped out of the OPS sprint?';

// Adding a model to the roster is an operator's.
test.use({ roles: ['renkei-user', 'renkei-operator'] });

test('a sealed chat opens for its enrolled owner', async ({ page, person: _person }, testInfo) => {
  const tag = `${testInfo.project.name}-${randomUUID().slice(0, 6)}`;
  const title = `Sprint retro prep ${tag}`;
  const modelId = await addStubModel(page.request, tag);
  try {
    const created = await page.request.post('/api/chat/chats', {
      data: { llmModelId: modelId },
    });
    expect(created.status(), await created.text()).toBe(201);
    const { chatId } = await created.json();
    const renamed = await page.request.patch(`/api/chat/chats/${chatId}`, { data: { title } });
    expect(renamed.ok(), await renamed.text()).toBe(true);
    const asked = await page.request.post(`/api/chat/chats/${chatId}/turns`, {
      data: { text: QUESTION, llmModelId: modelId },
    });
    expect(asked.status(), await asked.text()).toBe(202);

    await expect(async () => {
      await page.goto(`/chat/${chatId}`);
      await expect(page.getByText(LLM_STUB_REPLY)).toBeVisible({ timeout: 2_000 });
    }).toPass({ timeout: 30_000 });
    await expect(page.getByText(QUESTION)).toBeVisible();
    await expect(page.getByText(title).filter({ visible: true }).first()).toBeVisible();
    // Nothing for the KeyGuard to ask: the key is delegated for this session.
    await expect(page.getByTestId('chat-key-unavailable-notice')).toHaveCount(0);
  } finally {
    await removeModel(page.request, modelId);
  }
});
