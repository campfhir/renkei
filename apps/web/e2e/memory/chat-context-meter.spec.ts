/**
 * The chat's context meter: how many tokens the conversation uses against
 * the model's recorded context window, as a small ring. The reply's usage
 * is the model's own: the scripted stand-in model
 * (e2e/support/stub-model.ts) reports 40k in, 2k out, 30k of it cached,
 * and the turn engine records it as a finished turn does. Cases: a model
 * with a window (the ring), a model without one (nothing shown), a
 * compaction since the reply (the ring falls to the estimate), and a
 * phone-width pass.
 */

import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { Page, TestInfo } from '@playwright/test';
import { test, expect } from './fixtures';
import { addStubModel, removeModel, scripted } from '../support/stub-model';
import { createChat, send, settled } from '../support/chat';

// Adding a model to the roster is an operator's.
test.use({ roles: ['renkei-user', 'renkei-operator'] });

const HELLO = scripted('Hello there.', [
  { text: 'Hi!', usage: { input: 40_000, output: 2_000, cached: 30_000 } },
]);

async function shot(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  await page.screenshot({
    path: path.join(
      import.meta.dirname,
      '..',
      '..',
      'test-results',
      'screens',
      testInfo.project.name,
      `${name}.png`
    ),
    fullPage: true,
  });
}

test.describe('chat context meter', () => {
  test('shows used / limit with a bar when the model has a window, and the count alone when not', async ({
    page,
    person: _person,
  }, testInfo) => {
    const tag = `${testInfo.project.name}-${randomUUID().slice(0, 6)}`;
    const limitedModel = await addStubModel(page.request, `${tag}-limited`, {
      contextWindow: 200_000,
    });
    const openModel = await addStubModel(page.request, `${tag}-open`);
    try {
      const limitedTitle = `Context meter limited ${tag}`;
      const openTitle = `Context meter open ${tag}`;
      const foldedTitle = `Context meter compacted ${tag}`;
      const limitedChat = await createChat(page.request, {
        llmModelId: limitedModel,
        title: limitedTitle,
      });
      await send(page.request, limitedChat, HELLO, limitedModel);
      const openChat = await createChat(page.request, { llmModelId: openModel, title: openTitle });
      await send(page.request, openChat, HELLO, openModel);
      // Long enough that a compaction pass has something to fold
      // (compaction.ts keeps the last 20 messages and folds at least 6).
      const foldedChat = await createChat(page.request, {
        llmModelId: limitedModel,
        title: foldedTitle,
      });
      for (let index = 1; index <= 12; index += 1) {
        await send(page.request, foldedChat, `Earlier question ${index}.`, limitedModel);
      }
      await send(page.request, foldedChat, HELLO, limitedModel);

      await page.goto(`/chat/${limitedChat}`);
      await expect(page.getByRole('heading', { level: 1, name: limitedTitle })).toBeVisible();
      const meter = page.getByTestId('context-meter').filter({ visible: true });
      await expect(meter).toHaveAttribute('aria-valuenow', '21');
      await expect(meter).toHaveAttribute('title', 'Context: 42k of 200k tokens (21%)');
      await shot(page, testInfo, 'chat-context-meter-limited');

      await page.setViewportSize({ width: 390, height: 844 });
      await expect(meter).toBeVisible();
      await shot(page, testInfo, 'chat-context-meter-limited-mobile');
      await page.setViewportSize({ width: 1440, height: 900 });

      // No recorded window: nothing to measure against, so nothing shown.
      await page.goto(`/chat/${openChat}`);
      await expect(page.getByRole('heading', { level: 1, name: openTitle })).toBeVisible();
      await expect(page.getByTestId('context-meter').filter({ visible: true })).toHaveCount(0);

      // Before the compaction the last reply's usage is the measure.
      await page.goto(`/chat/${foldedChat}`);
      await expect(page.getByRole('heading', { level: 1, name: foldedTitle })).toBeVisible();
      await expect(page.getByTestId('context-meter').filter({ visible: true })).toHaveAttribute(
        'aria-valuenow',
        '21'
      );

      // A compaction newer than the last reply: its usage no longer describes
      // the history, so the ring falls to the estimate — the chat's prompt
      // and tools as the last turn measured them, plus the summary and what
      // was kept.
      const compacted = await page.request.post(`/api/chat/chats/${foldedChat}/compact`);
      expect(compacted.status(), await compacted.text()).toBe(202);
      await settled(page.request, foldedChat);
      await page.reload();
      await expect(page.getByRole('heading', { level: 1, name: foldedTitle })).toBeVisible();
      const reset = page.getByTestId('context-meter').filter({ visible: true });
      await expect(reset).toBeVisible();
      const resetPercent = Number(await reset.getAttribute('aria-valuenow'));
      expect(resetPercent).toBeGreaterThanOrEqual(0);
      expect(resetPercent).toBeLessThan(21);
      await shot(page, testInfo, 'chat-context-meter-after-compaction');
    } finally {
      await removeModel(page.request, limitedModel);
      await removeModel(page.request, openModel);
    }
  });
});
