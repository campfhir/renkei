/**
 * A chat reply whose tool call is bound to an MCP Apps widget card
 * (`_meta.ui.resourceUri`, lib/mcp-tools/widgets.ts): the thread renders
 * the real widget bundle in a sandboxed iframe (widget-card.tsx) instead
 * of the raw JSON `structuredContent` a plain tool result would show.
 *
 * The reply is a real turn (e2e/support/preview-cards.ts): the stand-in
 * model calls jira_create_issue_preview for a person who connected Jira.
 * The widget HTML is the real built bundle, served by the real widgets
 * route, and the `ui/update-model-context` a decision sends is a real
 * write that opens a real turn — the model's reply to the decision is
 * what a person waits for after the card. Only the confirm button's
 * `tools/call` is answered at the browser edge, since for real it would
 * reach Jira.
 */

import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { Page, TestInfo } from '@playwright/test';
import { test, expect } from './fixtures';
import { connectJira } from './support/connectors';
import { addStubModel, removeModel, type StubStep } from './support/stub-model';
import { ISSUE_INPUT, preview, previewChat, turnsOf } from './support/preview-cards';

// The stand-in model is an operator's to put on the roster.
test.use({ roles: ['renkei-user', 'renkei-operator'] });

const MOBILE_VIEWPORT = { width: 390, height: 844 };
/** First hits compile routes in `next dev`: the iframe, the model-context route, the stream. */
const COLD = { timeout: 30_000 };
/** The model's answer once the person has decided. */
const ANSWER = 'Noted — that is settled on the card.';

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

/** The preview, its reply, and the answer to the decision a card opens. */
function steps(previews: Record<string, unknown>[], said: string): StubStep[] {
  return [
    { text: said, tools: previews.map(preview) },
    { text: 'Waiting on your decision.' },
    { text: ANSWER },
  ];
}

async function oneCard(page: Page) {
  const title = `Rotate the webhook secret (${tag})`;
  const staged = await previewChat(page, {
    modelId,
    title,
    prompt: 'File a task to rotate the Zoom webhook secret.',
    steps: steps([ISSUE_INPUT], 'Here’s a preview — nothing is created until you confirm.'),
  });
  return { ...staged, title, previewId: staged.previewIds[0] ?? '' };
}

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

/**
 * The note line the decision became (message-list.tsx's PersonNote): a
 * small `<p>` carrying the whole text as its title.
 */
function noteLine(page: Page, text: string) {
  return page.locator('p[title]', { hasText: text });
}

/** The card's frame, in the main column (a streamed render can hold a hidden copy). */
function cardFrame(page: Page) {
  return page.getByRole('main').frameLocator('iframe[title="Preview card"]');
}

/** The turn a decision opened has run its course: a note on it, and nothing running. */
async function decided(page: Page, chatId: string): Promise<void> {
  await expect
    .poll(async () => {
      const { running, notes } = await turnsOf(page, chatId);
      return { running, noted: notes > 0 };
    }, COLD)
    .toEqual({ running: false, noted: true });
}

test('a preview tool renders its card, and confirming it runs the real tool call and the model replies', async ({
  page,
  browser,
}, testInfo) => {
  const { chatId, title } = await oneCard(page);

  const confirmCall: { value: { name: unknown; arguments: unknown } | null } = { value: null };
  await page.route('**/chat/chats/*/widget/tool-call', async (route) => {
    confirmCall.value = route.request().postDataJSON();
    await route.fulfill({
      json: {
        result: {
          content: [
            {
              type: 'text',
              // A blank line before the link, matching the real confirm
              // tools' shape (jira/write.ts).
              text: 'Created issue OPS-99.\n\n[Open in Jira](https://example.atlassian.net/browse/OPS-99)',
            },
          ],
          isError: false,
          meta: {},
        },
      },
    });
  });

  await page.goto(`/chat/${chatId}`);
  await expect(page.getByRole('heading', { level: 1, name: title })).toBeVisible(COLD);

  // The card, not a folded raw-JSON block.
  const frame = cardFrame(page);
  await expect(frame.locator('.card-title')).toHaveText('Create Jira issue', COLD);
  await expect(frame.locator('.card-subtitle').first()).toHaveText('OPS · Task');
  await expect(frame.getByText('Priority')).toBeVisible();
  await expect(frame.locator('.field-value', { hasText: 'High' })).toBeVisible();
  const confirmButton = frame.getByRole('button', { name: 'Create' });
  await expect(confirmButton).toBeVisible();
  await shot(page, testInfo, 'widget-card-preview.png');

  await confirmButton.click();
  await expect(frame.locator('.done-headline')).toHaveText('Created issue OPS-99.');
  const link = frame.getByRole('link', { name: 'Open in Jira' });
  await expect(link).toHaveAttribute('href', 'https://example.atlassian.net/browse/OPS-99');
  await shot(page, testInfo, 'widget-card-done.png');

  expect(confirmCall.value?.name).toBe('jira_create_issue_confirm');
  expect(confirmCall.value?.arguments).toMatchObject({
    projectKey: 'OPS',
    summary: 'Rotate the Zoom webhook secret',
  });

  // ui/update-model-context is not mocked: a real note row that is also
  // the user row of a new turn, so the model answers the decision at once.
  const note = noteLine(page, 'The user confirmed "Create Jira issue" on the preview card');
  await expect(note).toBeVisible(COLD);
  await expect(page.getByText(ANSWER)).toBeVisible(COLD);
  await shot(page, testInfo, 'widget-card-replied.png');
  await decided(page, chatId);
  await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeVisible();

  // The decision is durable (/widget/decision, a real write): a reload
  // shows the receipt instead of live buttons.
  await page.reload();
  await expect(frame.locator('.done-headline')).toHaveText('Created issue OPS-99.', COLD);
  await expect(frame.getByRole('link', { name: 'Open in Jira' })).toHaveAttribute(
    'href',
    'https://example.atlassian.net/browse/OPS-99'
  );
  await expect(frame.getByRole('button', { name: 'Create' })).toHaveCount(0);
  await expect(frame.locator('.card-title')).toHaveCount(0);
  await expect(
    noteLine(page, 'The user confirmed "Create Jira issue" on the preview card')
  ).toBeVisible();
  await expect(page.getByText(ANSWER)).toBeVisible();

  // A second device (no localStorage, and no tools/call answer wired up):
  // the same durable decision resolves it there too.
  const cookies = await page.context().cookies();
  const fresh = await browser.newContext();
  try {
    await fresh.addCookies(cookies);
    const freshPage = await fresh.newPage();
    await freshPage.goto(`/chat/${chatId}`);
    await expect(freshPage.getByRole('heading', { level: 1, name: title })).toBeVisible(COLD);
    const freshFrame = cardFrame(freshPage);
    await expect(freshFrame.locator('.done-headline')).toHaveText('Created issue OPS-99.', COLD);
    await expect(freshFrame.getByRole('button', { name: 'Create' })).toHaveCount(0);
  } finally {
    await fresh.close();
  }
});

test('cancelling the card is a decision too: the model replies to it', async ({
  page,
}, testInfo) => {
  const { chatId, title } = await oneCard(page);
  // Cancel never calls a tool; a hit here would be a bug.
  const confirmCalls: unknown[] = [];
  await page.route('**/chat/chats/*/widget/tool-call', async (route) => {
    confirmCalls.push(route.request().postDataJSON());
    await route.fulfill({ status: 500, json: { error: 'not expected' } });
  });

  await page.goto(`/chat/${chatId}`);
  await expect(page.getByRole('heading', { level: 1, name: title })).toBeVisible(COLD);
  const frame = cardFrame(page);
  const cancelButton = frame.getByRole('button', { name: 'Cancel' });
  await expect(cancelButton).toBeVisible(COLD);

  await cancelButton.click();
  await expect(frame.locator('.done-headline')).toHaveText('Cancelled');
  expect(confirmCalls).toEqual([]);

  const note = noteLine(page, 'The user cancelled "Create Jira issue" from the preview card');
  await expect(note).toBeVisible(COLD);
  await expect(page.getByText(ANSWER)).toBeVisible(COLD);
  await decided(page, chatId);
  await shot(page, testInfo, 'widget-card-cancelled.png');

  await page.reload();
  await expect(frame.locator('.done-headline')).toHaveText('Cancelled', COLD);
  await expect(frame.getByRole('button', { name: 'Cancel' })).toHaveCount(0);
});

test('a stale card refuses to re-run a confirm tool another device already decided', async ({
  page,
}) => {
  const { chatId, title, previewId } = await oneCard(page);
  // Not answered at the edge: the real route refuses the call on its own.
  const toolCallRequests: unknown[] = [];
  page.on('request', (request) => {
    if (request.url().includes('/widget/tool-call')) toolCallRequests.push(request.postDataJSON());
  });

  await page.goto(`/chat/${chatId}`);
  await expect(page.getByRole('heading', { level: 1, name: title })).toBeVisible(COLD);
  const frame = cardFrame(page);
  const confirmButton = frame.getByRole('button', { name: 'Create' });
  await expect(confirmButton).toBeVisible(COLD);

  // Another device decides this card while this one still shows its live
  // form: the decision its card would report.
  const other = await page.request.post(`/api/chat/chats/${chatId}/widget/decision`, {
    data: {
      stateKey: `renkei-preview:${previewId}`,
      decision: 'confirmed',
      state: { icon: 'sent', headline: 'Created issue OPS-1.' },
    },
  });
  expect(other.ok(), await other.text()).toBe(true);

  await confirmButton.click();
  await expect(
    frame.getByText('This was already decided on another device — reload to see it.')
  ).toBeVisible();
  expect(toolCallRequests).toHaveLength(1);

  await page.reload();
  await expect(frame.locator('.done-headline')).toHaveText('Created issue OPS-1.', COLD);
  await expect(confirmButton).toHaveCount(0);
});

test('the card still renders at phone width', async ({ page }, testInfo) => {
  const { chatId, title } = await oneCard(page);
  await page.setViewportSize(MOBILE_VIEWPORT);
  await page.goto(`/chat/${chatId}`);
  await expect(page.getByRole('heading', { level: 1, name: title })).toBeVisible(COLD);
  await expect(cardFrame(page).locator('.card-title')).toHaveText('Create Jira issue', COLD);
  const bodyWidth = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(bodyWidth).toBeLessThanOrEqual(MOBILE_VIEWPORT.width);
  await shot(page, testInfo, 'widget-card-mobile.png');
});

test('two cards from one reply: deciding both opens exactly one turn, informed by each', async ({
  page,
}, testInfo) => {
  const title = `Rotate two webhook secrets (${tag})`;
  const { chatId } = await previewChat(page, {
    modelId,
    title,
    prompt: 'File two tasks: the Zoom and Webex webhook secrets.',
    steps: steps(
      [ISSUE_INPUT, { ...ISSUE_INPUT, summary: 'Rotate the Webex webhook secret' }],
      'Two previews — nothing is created until you confirm each.'
    ),
  });
  await page.route('**/chat/chats/*/widget/tool-call', async (route) => {
    await route.fulfill({
      json: {
        result: {
          content: [{ type: 'text', text: 'Created issue OPS-99.' }],
          isError: false,
          meta: {},
        },
      },
    });
  });

  await page.goto(`/chat/${chatId}`);
  await expect(page.getByRole('heading', { level: 1, name: title })).toBeVisible(COLD);
  const iframes = page.getByRole('main').locator('iframe[title="Preview card"]');
  await expect(iframes).toHaveCount(2, COLD);
  const frameA = iframes.nth(0).contentFrame();
  const frameB = iframes.nth(1).contentFrame();
  await expect(frameA.locator('.card-title')).toHaveText('Create Jira issue', COLD);
  await expect(frameB.locator('.card-title')).toHaveText('Create Jira issue', COLD);
  await expect(frameB.getByRole('textbox').first()).toHaveValue('Rotate the Webex webhook secret');

  // Card A alone: its note appears, but no turn opens yet — the model must
  // not answer having seen only one of the two cards.
  await frameA.getByRole('button', { name: 'Create' }).click();
  await expect(frameA.locator('.done-headline')).toHaveText('Created issue OPS-99.');
  const notes = noteLine(page, 'The user confirmed "Create Jira issue" on the preview card');
  await expect(notes).toHaveCount(1, COLD);
  await expect(page.getByText(ANSWER)).toHaveCount(0);
  expect((await turnsOf(page, chatId)).turns).toBe(1);

  // Card B decided too: now one turn opens, and the answer lands once.
  // Card A's note re-renders the thread around card B: pressed again until it takes.
  await expect(async () => {
    await frameB.getByRole('button', { name: 'Create' }).click({ timeout: 2_000 });
    await expect(frameB.locator('.done-headline')).toHaveText('Created issue OPS-99.', {
      timeout: 2_000,
    });
  }).toPass({ timeout: 20_000 });
  await expect(notes).toHaveCount(2, COLD);
  await expect(page.getByText(ANSWER)).toHaveCount(1, COLD);
  await decided(page, chatId);
  expect((await turnsOf(page, chatId)).turns).toBe(2);
  await shot(page, testInfo, 'widget-card-batched-decisions.png');
});
