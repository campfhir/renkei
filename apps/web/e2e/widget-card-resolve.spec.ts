/**
 * A preview card settled by the model instead of by its own buttons
 * (chat_widget_resolve, lib/chat/widget-state-tools.ts): the person says
 * they already did the thing, the model marks the card decided, and the
 * card — open in the thread, its Create/Cancel buttons live until then —
 * flips to the receipt as the tool returns (the turn's `widget_decided`
 * event, widget-card.tsx's second tool-result notification), stays that
 * way on reload (chat-view.ts's `resolved`), and can no longer be
 * confirmed from the card.
 *
 * The card is a real turn's (e2e/support/preview-cards.ts), and so is
 * everything after it: the person's message scripts the stand-in model's
 * chat_widget_resolve call, the permission card the runner parks on for a
 * tool that acts, the local tool's write, the event on the stream.
 * Nothing here reaches a vendor, so nothing is answered at the edge.
 */

import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { Page, TestInfo } from '@playwright/test';
import { test, expect } from './fixtures';
import { connectJira } from './support/connectors';
import { addStubModel, removeModel, scripted, toolStep } from './support/stub-model';
import { ISSUE_INPUT, preview, previewChat } from './support/preview-cards';

// The stand-in model is an operator's to put on the roster.
test.use({ roles: ['renkei-user', 'renkei-operator'] });

const MOBILE_VIEWPORT = { width: 390, height: 844 };
/** First hits compile routes in `next dev`. */
const COLD = { timeout: 30_000 };
const ANSWER = 'Marked done on the card.';

let modelId = '';
let tag = '';

test.beforeEach(async ({ page, person: _person }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-light', 'One project is enough for the card.');
  test.slow();
  tag = `${testInfo.project.name}-${randomUUID().slice(0, 6)}`;
  await connectJira(page);
  modelId = await addStubModel(page.request, tag);
});

test.afterEach(async ({ page }, testInfo) => {
  if (testInfo.project.name !== 'desktop-light') return;
  await removeModel(page.request, modelId);
});

async function shot(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  await page.screenshot({
    path: path.join(
      import.meta.dirname,
      '..',
      'test-results',
      'screens',
      testInfo.project.name,
      name
    ),
    fullPage: true,
  });
}

async function resolveFromTheComposer(
  page: Page,
  testInfo: TestInfo,
  screens: { before: string; ask: string; after: string }
): Promise<{ chatId: string; previewId: string }> {
  const title = `Rotate the webhook secret (${tag})`;
  const { chatId, previewIds } = await previewChat(page, {
    modelId,
    title,
    prompt: 'File a task to rotate the Zoom webhook secret.',
    steps: [
      {
        text: 'Here’s a preview — nothing is created until you confirm.',
        tools: [preview(ISSUE_INPUT)],
      },
      { text: 'Waiting on your decision.' },
    ],
  });
  const previewId = previewIds[0] ?? '';
  await page.goto(`/chat/${chatId}`);
  await expect(page.getByRole('heading', { level: 1, name: title })).toBeVisible(COLD);

  // The card is live: its form, its Create button. Scoped to the main
  // column: a streamed render can hold a second, src-less copy outside it.
  const frame = page.getByRole('main').frameLocator('iframe[title="Preview card"]');
  await expect(frame.locator('.card-title')).toHaveText('Create Jira issue', COLD);
  await expect(frame.getByRole('button', { name: 'Create' })).toBeVisible();
  await expect(frame.locator('.done-headline')).toHaveCount(0);
  await shot(page, testInfo, screens.before);

  // The person says they did it by hand; the model reaches for
  // chat_widget_resolve with the card's id — a tool that acts, so the
  // turn parks on the permission card first, like any other write.
  const box = page.getByRole('textbox', { name: 'Message' });
  await box.fill(
    scripted('I already filed that one by hand.', [
      toolStep('chat_widget_resolve', {
        widget: previewId,
        outcome: 'done',
        headline: 'Created by hand in Jira',
        detail: 'OPS-123, filed from the Jira UI',
      }),
      { text: ANSWER },
    ])
  );
  await box.press('Enter');
  const ask = page.getByRole('group', { name: 'Permission needed' });
  await expect(ask).toBeVisible(COLD);
  await expect(page.getByText('chat_widget_resolve').first()).toBeVisible();
  await shot(page, testInfo, screens.ask);
  // Clicked again until it takes: a card that streamed in before the page
  // hydrated can miss the first click.
  await expect(async () => {
    await ask.getByRole('button', { name: 'Allow once' }).click({ timeout: 2_000 });
    await expect(ask).toBeHidden({ timeout: 2_000 });
  }).toPass({ timeout: 20_000 });

  // The tool ran: the card flips to the receipt in place — no reload, the
  // same iframe — and its buttons are gone.
  await expect(frame.locator('.done-headline')).toHaveText('Created by hand in Jira', COLD);
  await expect(frame.locator('.done-detail')).toHaveText('OPS-123, filed from the Jira UI');
  await expect(frame.getByRole('button', { name: 'Create' })).toHaveCount(0);
  await expect(frame.locator('.card-title')).toHaveCount(0);
  // And the model's turn carried on to its reply.
  await expect(page.getByText(ANSWER)).toBeVisible(COLD);
  await shot(page, testInfo, screens.after);

  // The receipt is what every later load shows.
  await page.reload();
  await expect(frame.locator('.done-headline')).toHaveText('Created by hand in Jira', COLD);
  await expect(frame.locator('.done-detail')).toHaveText('OPS-123, filed from the Jira UI');
  await expect(frame.getByRole('button', { name: 'Create' })).toHaveCount(0);
  return { chatId, previewId };
}

test('the model marks a card decided on the person’s word, and the open card flips to the receipt', async ({
  page,
}, testInfo) => {
  const { chatId, previewId } = await resolveFromTheComposer(page, testInfo, {
    before: 'widget-resolve-live.png',
    ask: 'widget-resolve-ask.png',
    after: 'widget-resolve-done.png',
  });

  // Once decided, the card's own confirm can no longer run — the same
  // guard as a second device (widget-tools.ts's confirmWidgetTool).
  const refused = await page.request.post(`/api/chat/chats/${chatId}/widget/tool-call`, {
    data: {
      name: 'jira_create_issue_confirm',
      arguments: { previewId, ...ISSUE_INPUT },
      stateKey: `renkei-preview:${previewId}`,
    },
  });
  expect(refused.status()).toBe(409);
  expect(await refused.json()).toMatchObject({ code: 'already-decided' });
});

test('the same, at phone width', async ({ page }, testInfo) => {
  await page.setViewportSize(MOBILE_VIEWPORT);
  await resolveFromTheComposer(page, testInfo, {
    before: 'widget-resolve-live-mobile.png',
    ask: 'widget-resolve-ask-mobile.png',
    after: 'widget-resolve-done-mobile.png',
  });
});
