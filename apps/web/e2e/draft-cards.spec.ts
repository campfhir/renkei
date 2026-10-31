/**
 * Drafting and scheduling cards.
 *
 * A draft card (outlook_draft_mail, webex_draft_message) is the partner of
 * the preview-to-send card: no Send, so nothing leaves. The Outlook one
 * saves edits to the draft and "Delete draft" removes it; WebEx stores no
 * drafts, so its card only holds the text and Discard closes it. The send
 * card gains "Send later", which turns Send into Schedule and hands the
 * confirm tool a `sendAt`.
 *
 * Same harness as email-card-discard.spec.ts: the real built bundles and
 * decision routes, a chat on the stand-in model, the vendor tools' answers
 * and the card's `tools/call` replies handed over at the browser edge.
 */

import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { Page, TestInfo } from '@playwright/test';
import { test, expect } from './fixtures';
import { addStubModel, removeModel } from './support/stub-model';
import { createChat, sendForCards, widgetUri, type ToolCard } from './support/tool-cards';

const COLD = { timeout: 30_000 };
const RESULTS = path.join(import.meta.dirname, '..', 'test-results');
const EMAIL_COMPOSE_URI = widgetUri('email-compose.ts', 'email-compose');
const CHAT_MESSAGE_URI = widgetUri('chat-message.ts', 'chat-message');

test.use({ roles: ['renkei-user', 'renkei-operator'] });

function emailCard(mode: 'draft' | 'send', draftId: string): ToolCard {
  return {
    toolUseId: `toolu_${randomUUID().slice(0, 8)}`,
    tool: mode === 'draft' ? 'outlook_draft_mail' : 'outlook_send_mail_preview',
    input: { to: ['vendor@example.com'], subject: 'Invoice question', body: 'About 1042.' },
    content: 'The email is drafted.',
    uiResourceUri: EMAIL_COMPOSE_URI,
    structuredContent: {
      kind: 'compose',
      ...(mode === 'draft' ? { mode } : {}),
      draftId,
      to: ['vendor@example.com'],
      cc: [],
      bcc: [],
      subject: 'Invoice question',
      body: 'About 1042.',
      bodyHtml: '<p>About 1042.</p>',
    },
  };
}

function webexCard(): ToolCard {
  return {
    toolUseId: `toolu_${randomUUID().slice(0, 8)}`,
    tool: 'webex_draft_message',
    input: { markdown: 'Standup moved to 10.' },
    content: 'Drafted on a card.',
    uiResourceUri: CHAT_MESSAGE_URI,
    structuredContent: {
      previewId: randomUUID(),
      kind: 'webex',
      mode: 'draft',
      markdown: 'Standup moved to 10.',
    },
  };
}

async function openChat(page: Page, testInfo: TestInfo, card: ToolCard) {
  const tag = `${testInfo.project.name}-${randomUUID().slice(0, 6)}`;
  const modelId = await addStubModel(page.request, tag);
  const title = `Drafts (${tag})`;
  const chatId = await createChat(page.request, { modelId, title });
  await page.goto(`/chat/${chatId}`);
  await expect(page.getByRole('heading', { level: 1, name: title })).toBeVisible(COLD);
  await sendForCards(page, {
    modelId,
    chatId,
    prompt: 'Draft it.',
    assistantText: 'Here you go.',
    cards: [card],
  });
  return modelId;
}

/** Stand in for Graph: every card tool call succeeds; saves answer with the draft id. */
async function mockCardTools(page: Page): Promise<CardCall[]> {
  const calls: CardCall[] = [];
  await page.route('**/chat/chats/*/widget/tool-call', async (route) => {
    const body = route.request().postDataJSON();
    calls.push(body);
    await route.fulfill({
      json: {
        result: {
          content: [{ type: 'text', text: 'Done.' }],
          structuredContent: { draftId: 'draft-saved' },
        },
      },
    });
  });
  return calls;
}

interface CardCall {
  name: string;
  arguments: Record<string, unknown>;
}

const frameOf = (page: Page) => page.frameLocator('iframe[title="Preview card"]').first();

test('an Outlook draft card has no Send: save keeps it, delete removes it', async ({
  page,
  person: _person,
}, testInfo) => {
  test.setTimeout(150_000);
  let modelId: string | null = null;
  try {
    modelId = await openChat(page, testInfo, emailCard('draft', 'AAMkAD-draft'));
    const calls = await mockCardTools(page);
    const frame = frameOf(page);
    await expect(frame.getByText('Draft: New email')).toBeVisible(COLD);
    await expect(frame.getByRole('button', { name: 'Send', exact: true })).toHaveCount(0);

    await frame.locator('input').nth(1).fill('Invoice question — v2');
    await frame.getByRole('button', { name: 'Save draft' }).click();
    await expect(frame.getByText('Saved to Drafts')).toBeVisible(COLD);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      name: 'outlook_update_draft_confirm',
      arguments: { draftId: 'AAMkAD-draft', overrides: { subject: 'Invoice question — v2' } },
    });
    // Still a live form afterwards.
    await expect(frame.locator('textarea')).toBeEditable();

    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({
      path: path.join(RESULTS, 'screens', testInfo.project.name, 'email-draft-card.png'),
      fullPage: true,
    });

    await frame.getByRole('button', { name: 'Delete draft' }).click();
    await expect(frame.locator('.done-headline')).toHaveText('Draft deleted', COLD);
    expect(calls.at(-1)).toMatchObject({ name: 'outlook_discard_draft_confirm' });
  } finally {
    if (modelId) await removeModel(page.request, modelId);
  }
});

test('the send card schedules: a picked time turns Send into Schedule and sends sendAt', async ({
  page,
  person: _person,
}, testInfo) => {
  test.setTimeout(150_000);
  let modelId: string | null = null;
  try {
    modelId = await openChat(page, testInfo, emailCard('send', 'AAMkAD-send'));
    const calls = await mockCardTools(page);
    const frame = frameOf(page);
    await expect(frame.getByRole('button', { name: 'Send', exact: true })).toBeVisible(COLD);

    const later = frame.locator('input[type="datetime-local"]');
    // Too soon is refused on the card, before any call.
    await later.fill(new Date(Date.now() - 3_600_000).toISOString().slice(0, 16));
    await frame.getByRole('button', { name: 'Schedule' }).click();
    await expect(frame.getByText('at least a minute from now')).toBeVisible(COLD);
    expect(calls).toHaveLength(0);

    const when = new Date(Date.now() + 26 * 3_600_000);
    const local = new Date(when.getTime() - when.getTimezoneOffset() * 60_000)
      .toISOString()
      .slice(0, 16);
    await later.fill(local);
    await frame.getByRole('button', { name: 'Schedule' }).click();
    await expect(frame.locator('.done-headline')).toHaveText('Scheduled', COLD);
    expect(calls).toHaveLength(1);
    expect(calls[0].name).toBe('outlook_send_draft_confirm');
    expect(Date.parse(String(calls[0].arguments.sendAt))).toBe(Date.parse(`${local}`));
  } finally {
    if (modelId) await removeModel(page.request, modelId);
  }
});

test('a WebEx draft card holds the text and cannot send', async ({
  page,
  person: _person,
}, testInfo) => {
  test.setTimeout(150_000);
  let modelId: string | null = null;
  try {
    modelId = await openChat(page, testInfo, webexCard());
    const calls = await mockCardTools(page);
    const frame = frameOf(page);
    await expect(frame.getByText('Draft: WebEx message')).toBeVisible(COLD);
    await expect(frame.getByText('No destination yet')).toBeVisible();
    await expect(frame.getByRole('button', { name: 'Send', exact: true })).toHaveCount(0);
    await expect(frame.locator('textarea')).toHaveValue('Standup moved to 10.');

    await frame.getByRole('button', { name: 'Discard draft' }).click();
    await expect(frame.locator('.done-headline')).toHaveText('Draft discarded', COLD);
    expect(calls).toHaveLength(0);
  } finally {
    if (modelId) await removeModel(page.request, modelId);
  }
});
