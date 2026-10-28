/**
 * Chat compaction's UI, against the real turn engine: every reply and
 * every summary comes from the stand-in model (e2e/support/stub-model.ts),
 * scripted where a test needs a tool call or a slow answer.
 *
 * Four things get exercised:
 *  - the chat_compact tool call renders with the package icon;
 *  - a compaction pass already running when the page opens (its summary
 *    call held by the stub) shows the live progress card, then settles
 *    without a reload;
 *  - /compact and the prompt picker's quick action both start a REAL
 *    compaction turn through the actual route and SSE stream, settling to
 *    "nothing to fold" on a chat too small to need one;
 *  - a message sent while another turn is already running queues instead
 *    of being silently dropped, survives a reload, and drains on its own
 *    once the model is free.
 */

import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { APIRequestContext, Page, TestInfo } from '@playwright/test';
import { test, expect } from './fixtures';
import { addStubModel, toolStep, removeModel, scripted, type StubStep } from './support/stub-model';
import { createChat, readChat, send, settled, startTurn } from './support/chat';

// Adding a model to the roster is an operator's.
test.use({ roles: ['renkei-user', 'renkei-operator'] });

/** components/icons.tsx's `package` entry — asserted literally, not imported. */
const PACKAGE_ICON_D = 'M12 3l8 4.5v9L12 21l-8-4.5v-9zM4 7.5L12 12l8-4.5M12 12v9M8 5.25l8 4.5';
const NOTHING = 'Nothing to compact — the conversation is already tight.';

function tagOf(testInfo: TestInfo): string {
  return `${testInfo.project.name}-${randomUUID().slice(0, 6)}`;
}

async function shot(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  await page.screenshot({
    path: path.join(
      import.meta.dirname,
      '..',
      'test-results',
      'screens',
      testInfo.project.name,
      `${name}.png`
    ),
  });
}

/**
 * Enough history that a pass has something to fold (compaction.ts keeps 20,
 * folds at least 6). `summary` scripts the one-shot call that folds the
 * first message: the pass's summary.
 */
async function longHistory(
  request: APIRequestContext,
  chatId: string,
  modelId: string,
  summary?: StubStep
) {
  for (let index = 1; index <= 13; index += 1) {
    const text = `Earlier question ${index}.`;
    await send(request, chatId, index === 1 && summary ? scripted(text, [summary]) : text, modelId);
  }
}

test.describe('chat compaction', () => {
  // A long history is a dozen real turns, and the last test waits out a slow reply.
  test.slow();
  test('a chat_compact tool call renders with the package icon', async ({
    page,
    person: _person,
  }, testInfo) => {
    const tag = tagOf(testInfo);
    const title = `Compaction icon check ${tag}`;
    const prompt = 'This is getting long — trim the older part.';
    const modelId = await addStubModel(page.request, tag);
    try {
      const chatId = await createChat(page.request, { llmModelId: modelId, title });
      await longHistory(page.request, chatId, modelId);
      // Compacting acts on the chat, so the turn asks first: allowed once.
      const steps = [
        toolStep('chat_compact', {}, "I'll compact the earlier part of this conversation."),
        { text: 'Done — the earlier back-and-forth is now a summary.' },
      ];
      await send(page.request, chatId, scripted(prompt, steps), modelId, { allow: true });

      await page.goto(`/chat/${chatId}`);
      await expect(page.getByRole('heading', { level: 1, name: title })).toBeVisible();
      const work = page.locator('details.chat-fold', { hasText: '1 tool call' }).last();
      await expect(work).toBeVisible();
      await work.locator('> summary').click();
      const call = work.locator('details.chat-fold', { hasText: 'Compact' });
      await expect(call).toBeVisible();
      await expect(call.locator('> summary')).toContainText('Called');
      await expect(call.locator('> summary svg path').first()).toHaveAttribute('d', PACKAGE_ICON_D);
      await call.locator('> summary').click();
      await expect(call.getByText(/Folded \d+ earlier message/)).toBeVisible();
      await expect(
        page.getByText('Done — the earlier back-and-forth is now a summary.')
      ).toBeVisible();
    } finally {
      await removeModel(page.request, modelId);
    }
  });

  test('a compaction turn already running shows live progress and settles', async ({
    page,
    person: _person,
  }, testInfo) => {
    const tag = tagOf(testInfo);
    const title = `Compaction snapshot check ${tag}`;
    const modelId = await addStubModel(page.request, tag);
    try {
      const chatId = await createChat(page.request, { llmModelId: modelId, title });
      // The pass's summary is held for a while.
      await longHistory(page.request, chatId, modelId, {
        oneShot: true,
        delayMs: 6_000,
        text: 'A summary of the start.',
      });
      // The pass starts before the page is open: it reaches the browser on load.
      const started = await page.request.post(`/api/chat/chats/${chatId}/compact`);
      expect(started.status(), await started.text()).toBe(202);

      await page.goto(`/chat/${chatId}`);
      await expect(page.getByRole('heading', { level: 1, name: title })).toBeVisible();
      await expect(page.getByText(/Compacting the conversation…/)).toBeVisible({ timeout: 15_000 });
      await shot(page, testInfo, 'chat-compaction-running');
      // The summary lands; the card settles without a page reload.
      await expect(page.getByText(/Compacted \d+ earlier messages? into a summary\./)).toBeVisible({
        timeout: 20_000,
      });
    } finally {
      await removeModel(page.request, modelId);
    }
  });

  test('/compact and the prompt picker each run a real compaction pass', async ({
    page,
    person: _person,
  }, testInfo) => {
    const tag = tagOf(testInfo);
    const title = `Compaction live check ${tag}`;
    const modelId = await addStubModel(page.request, tag);
    try {
      const chatId = await createChat(page.request, { llmModelId: modelId, title });
      // Well under what a pass folds: compactChat returns before reaching the model.
      await send(page.request, chatId, 'Just saying hello.', modelId);

      await page.goto(`/chat/${chatId}`);
      await expect(page.getByRole('heading', { level: 1, name: title })).toBeVisible();

      // The literal slash command.
      const box = page.getByRole('textbox', { name: 'Message' });
      const passes: number[] = [];
      page.on('response', (response) => {
        if (response.url().endsWith(`/api/chat/chats/${chatId}/compact`)) {
          passes.push(response.status());
        }
      });
      await box.fill('/compact');
      await page.getByRole('button', { name: 'Send', exact: true }).click();
      await expect(box).toHaveValue('');
      await expect(page.getByText(NOTHING)).toBeVisible({ timeout: 10_000 });

      // The prompt picker's quick action — opened on an empty box, since
      // typing "/" there is the picker's own trigger.
      await expect(box).toHaveValue('');
      await box.press('/');
      const compactAction = page.getByRole('button', { name: /Compact this conversation/ });
      await expect(compactAction).toBeVisible();
      await expect(compactAction.locator('svg path').first()).toHaveAttribute('d', PACKAGE_ICON_D);
      await compactAction.click();
      // Proves a SECOND pass actually started — the card's settled text is
      // already showing from the first, so asserting on it alone would pass
      // even if this click did nothing: two passes were accepted, and the
      // chat has no turn left running.
      await expect.poll(() => passes, { timeout: 10_000 }).toEqual([202, 202]);
      await settled(page.request, chatId);
      await expect(page.getByText(NOTHING).first()).toBeVisible({ timeout: 10_000 });
    } finally {
      await removeModel(page.request, modelId);
    }
  });

  test('queued sends are listed individually, can be removed one at a time, and drain on their own once the model is free', async ({
    page,
    person: _person,
  }, testInfo) => {
    const tag = tagOf(testInfo);
    const title = `Compaction queue check ${tag}`;
    const busy = 'Take your time over this one.';
    const modelId = await addStubModel(page.request, tag);
    try {
      const chatId = await createChat(page.request, { llmModelId: modelId, title });
      // A reply in flight from the first paint: the model takes its time.
      await startTurn(
        page.request,
        chatId,
        scripted(busy, [{ delayMs: 45_000, text: 'Finally done.' }]),
        modelId
      );

      await page.goto(`/chat/${chatId}`);
      await expect(page.getByRole('heading', { level: 1, name: title })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Stop' })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Queue this message' })).toBeHidden();
      await shot(page, testInfo, 'chat-queue-empty-shows-stop');

      // Queue a plain message. One item stays inline, plain and simple —
      // no dialog to open for a queue of one.
      const box = page.getByRole('textbox', { name: 'Message' });
      // Typing swaps Stop out of the send slot for the blue queue button:
      // the one place a thumb goes to send must never stop the reply
      // instead. Stop returns once the box is empty again. (Typed again
      // until it takes: text filled before the page hydrates is lost.)
      const queueButton = page.getByRole('button', { name: 'Queue this message' });
      await expect(async () => {
        await box.fill('');
        await box.fill('Left this for when it is free.');
        await expect(queueButton).toBeVisible({ timeout: 1_000 });
      }).toPass({ timeout: 15_000 });
      await expect(page.getByRole('button', { name: 'Stop' })).toBeHidden();
      await expect(queueButton).toHaveClass(/bg-blue-600/);
      await shot(page, testInfo, 'chat-queue-draft-swaps-stop');

      // Phone width — where the mis-tap actually happened: the same swap,
      // and the composer row still fits without a sideways scroll.
      await page.setViewportSize({ width: 390, height: 844 });
      await expect(page.getByRole('button', { name: 'Stop' })).toBeHidden();
      await expect(queueButton).toBeVisible();
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth - document.documentElement.clientWidth
        )
      ).toBe(0);
      await shot(page, testInfo, 'chat-queue-draft-swaps-stop-mobile');
      await page.setViewportSize({ width: 1440, height: 900 });

      await queueButton.click();
      await expect(box).toHaveValue('');
      await expect(page.getByRole('button', { name: 'Stop' })).toBeVisible();
      await expect(page.getByText('Left this for when it is free.')).toBeVisible();
      await expect(page.getByRole('button', { name: 'View' })).toBeHidden();

      // Queue a second, different kind of send — a compaction pass, picked
      // from the prompt picker. With more than one, the inline row collapses
      // to a summary; the individual items move behind "View".
      await box.press('/');
      await page.getByRole('button', { name: /Compact this conversation/ }).click();
      await expect(page.getByText('2 queued', { exact: false })).toBeVisible();
      await expect(page.getByText('Left this for when it is free.')).toBeHidden();
      await page.getByRole('button', { name: 'View' }).click();
      const dialog = page.getByRole('dialog', { name: 'Queued (2)' });
      await expect(dialog).toBeVisible();
      await expect(dialog.getByText('Left this for when it is free.')).toBeVisible();
      await expect(dialog.getByText('Compact this conversation')).toBeVisible();
      await expect(dialog.getByRole('button', { name: 'Clear all' })).toBeVisible();

      // Pick and choose: remove just the first one. Back down to one item,
      // the dialog closes itself and that item returns inline.
      await dialog
        .getByRole('button', { name: 'Remove "Left this for when it is free." from the queue' })
        .click();
      await expect(dialog).toBeHidden();
      await expect(page.getByText('Compact this conversation')).toBeVisible();
      await expect(page.getByRole('button', { name: 'View' })).toBeHidden();

      // The queue is durable: the server holds it (the chat reads it back),
      // and a reload — which used to drop it — still shows what is waiting.
      await expect
        .poll(async () => (await readChat(page.request, chatId)).chat.queue.map((q) => q.kind))
        .toEqual(['compact']);
      await page.reload();
      await expect(page.getByRole('heading', { level: 1, name: title })).toBeVisible();
      await expect(page.getByText('Compact this conversation')).toBeVisible();
      await expect(page.getByText('queued', { exact: true })).toBeVisible();

      // The model finishes its reply — nobody clicks anything, the queued
      // compaction pass sends itself the moment the model is free.
      await expect(page.getByText('Finally done.')).toBeVisible({ timeout: 60_000 });
      await expect(page.getByText(/queued/)).toBeHidden({ timeout: 10_000 });
      await expect(page.getByText(NOTHING)).toBeVisible({ timeout: 10_000 });
      await settled(page.request, chatId);
      expect((await readChat(page.request, chatId)).chat.queue).toEqual([]);
    } finally {
      await removeModel(page.request, modelId);
    }
  });
});
