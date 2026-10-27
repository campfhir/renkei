/**
 * Email preview cards in one chat: discarding the first must leave the
 * next one fully editable — its To, Subject and Body are a live form, not
 * the receipt the discarded card shows. And a reply card is just as
 * editable (it used to be shown read-only, which read as exactly this
 * bug): an edited text goes to the confirm tool with the message it
 * answers, so the draft is rebuilt around the quoted thread.
 *
 * The real built email-compose bundle, the real decision and model-context
 * routes, a chat on the stand-in model whose turns run for real. What
 * Outlook's draft tools would have answered the model with — they need a
 * Microsoft grant, which only an OAuth sign-in makes — is handed to the
 * page as each turn's rows at the stream's browser edge
 * (e2e/support/tool-cards.ts), and the card's `tools/call` is answered
 * there too — for real it would reach Microsoft Graph.
 *
 * Not reached: the discarded card's receipt after a reload. A reload
 * renders the chat from the server's own rows, which hold no card (the
 * card only ever existed at the browser edge), so the first test checks
 * the receipt and the next card on the live page instead.
 */

import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { Page, TestInfo } from '@playwright/test';
import { test, expect } from './fixtures';
import { LLM_STUB_REPLY } from './constants';
import { addStubModel, removeModel } from '../support/stub-model';
import { createChat, sendForCards, widgetUri, type ToolCard } from '../support/tool-cards';

const COLD = { timeout: 30_000 };
const RESULTS = path.join(import.meta.dirname, '..', '..', 'test-results', 'memory');
const EMAIL_COMPOSE_URI = widgetUri('email-compose.ts', 'email-compose');

// Staging the stand-in model on the roster is an operator's.
test.use({ roles: ['renkei-user', 'renkei-operator'] });

interface Draft {
  toolUseId: string;
  draftId: string;
  subject: string;
  body: string;
  /** A reply card: the message it answers. */
  replyTo?: string;
}

function emailCard(draft: Draft): ToolCard {
  return {
    toolUseId: draft.toolUseId,
    tool: draft.replyTo ? 'outlook_reply_preview' : 'outlook_send_mail_preview',
    input: { to: ['vendor@example.com'], subject: draft.subject, body: draft.body },
    content: 'The email is drafted and awaiting the user’s decision on the preview card.',
    uiResourceUri: EMAIL_COMPOSE_URI,
    structuredContent: {
      kind: draft.replyTo ? 'reply' : 'compose',
      draftId: draft.draftId,
      ...(draft.replyTo ? { messageId: draft.replyTo } : {}),
      to: ['vendor@example.com'],
      cc: [],
      bcc: [],
      subject: draft.subject,
      body: draft.body,
      bodyHtml: `<p>${draft.body}</p>`,
    },
  };
}

function draftFor(which: 'a' | 'b'): Draft {
  return {
    toolUseId: `toolu_email_${which}_${randomUUID().slice(0, 8)}`,
    draftId: `AAMkAD-${randomUUID()}`,
    subject: which === 'a' ? 'Invoice question' : 'Invoice question, take two',
    body: which === 'a' ? 'Hi — about invoice 1042.' : 'Hello again — invoice 1042.',
  };
}

/** A chat of the person's own on the stand-in model. */
async function openChat(page: Page, testInfo: TestInfo) {
  const tag = `${testInfo.project.name}-${randomUUID().slice(0, 6)}`;
  const modelId = await addStubModel(page.request, tag);
  const title = `Email the vendor (${tag})`;
  const chatId = await createChat(page.request, { modelId, title });
  await page.goto(`/chat/${chatId}`);
  await expect(page.getByRole('heading', { level: 1, name: title })).toBeVisible(COLD);
  return { modelId, chatId };
}

/** The person asks; the reply carries one email card. */
async function askForEmail(
  page: Page,
  chat: { modelId: string; chatId: string },
  draft: Draft,
  prompt: string
): Promise<void> {
  await sendForCards(page, {
    ...chat,
    prompt,
    assistantText: 'Here’s the draft — nothing is sent until you confirm.',
    cards: [emailCard(draft)],
  });
}

/** Stand in for Graph: discard and send both succeed. Returns what the card called. */
async function mockGraph(page: Page): Promise<unknown[]> {
  const calls: unknown[] = [];
  await page.route('**/chat/chats/*/widget/tool-call', async (route) => {
    const body: unknown = route.request().postDataJSON();
    calls.push(body);
    const discard = JSON.stringify(body).includes('outlook_discard_draft_confirm');
    await route.fulfill({
      json: { result: { content: [{ type: 'text', text: discard ? 'Discarded.' : 'Sent.' }] } },
    });
  });
  return calls;
}

async function expectEditable(page: Page, card: number, text: string): Promise<void> {
  const frame = page.frameLocator('iframe[title="Preview card"]').nth(card);
  const body = frame.locator('textarea');
  await expect(body).toBeVisible(COLD);
  await expect(body).toBeEditable();
  await body.fill(text);
  await expect(body).toHaveValue(text);
  const subject = frame.locator('input').nth(1);
  await subject.fill('Edited subject');
  await expect(subject).toHaveValue('Edited subject');
}

test('discarding one email card leaves the next card in the chat editable', async ({
  page,
  person: _person,
}, testInfo) => {
  test.setTimeout(150_000);
  let modelId: string | null = null;
  try {
    const chat = await openChat(page, testInfo);
    modelId = chat.modelId;
    const calls = await mockGraph(page);
    await askForEmail(page, chat, draftFor('a'), 'Email the vendor.');

    const first = page.frameLocator('iframe[title="Preview card"]').first();
    await first.getByRole('button', { name: 'Discard' }).click(COLD);
    await expect(first.locator('.done-headline')).toHaveText('Discarded', COLD);
    expect(calls).toEqual([expect.objectContaining({ name: 'outlook_discard_draft_confirm' })]);
    await expect(page.getByText(LLM_STUB_REPLY).first()).toBeVisible(COLD);

    // The person asks for another email; it lands as a new turn.
    await askForEmail(page, chat, draftFor('b'), 'Try another email.');
    await expect(page.locator('iframe[title="Preview card"]')).toHaveCount(2, COLD);
    await expect(first.locator('.done-headline')).toHaveText('Discarded', COLD);
    await expectEditable(page, 1, 'A fresh body the person typed.');
  } finally {
    if (modelId) await removeModel(page.request, modelId);
  }
});

test('a card already on the page stays editable after another card is discarded', async ({
  page,
  person: _person,
}, testInfo) => {
  test.setTimeout(150_000);
  let modelId: string | null = null;
  try {
    const chat = await openChat(page, testInfo);
    modelId = chat.modelId;
    await mockGraph(page);
    // One reply, two drafts: both cards are on the page before either is decided.
    await sendForCards(page, {
      ...chat,
      prompt: 'Email the vendor, and draft one more.',
      assistantText: 'Here are the drafts — nothing is sent until you confirm.',
      cards: [emailCard(draftFor('a')), emailCard(draftFor('b'))],
    });

    await expect(page.locator('iframe[title="Preview card"]')).toHaveCount(2, COLD);
    const first = page.frameLocator('iframe[title="Preview card"]').first();
    await first.getByRole('button', { name: 'Discard' }).click(COLD);
    await expect(first.locator('.done-headline')).toHaveText('Discarded', COLD);
    await expect(page.getByText(LLM_STUB_REPLY).first()).toBeVisible(COLD);

    await expectEditable(page, 1, 'Typed after the other card was discarded.');
  } finally {
    if (modelId) await removeModel(page.request, modelId);
  }
});

test('a reply card is editable — recipients, subject and text — and an edit is sent with the message it answers', async ({
  page,
  person: _person,
}, testInfo) => {
  test.setTimeout(150_000);
  const reply = { ...draftFor('a'), subject: 'RE: Invoice 1042', replyTo: 'AAMkAD-msg-1042' };
  let modelId: string | null = null;
  try {
    const chat = await openChat(page, testInfo);
    modelId = chat.modelId;
    const calls = await mockGraph(page);
    await askForEmail(page, chat, reply, 'Reply to the vendor.');

    const frame = page.frameLocator('iframe[title="Preview card"]').first();
    await expect(
      frame.getByText('The quoted thread below your text is included on send.')
    ).toBeVisible(COLD);
    // A reply is as editable as a new email: recipients, subject and text.
    await frame.locator('input').first().fill('vendor@example.com, ap@example.com');
    await frame.locator('input').nth(1).fill('RE: Invoice 1042 — paid');
    const body = frame.locator('textarea');
    await expect(body).toHaveValue(reply.body);
    await body.fill('Thanks — paid today.');
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(body).toBeVisible();
    await page.screenshot({
      path: path.join(RESULTS, 'screens', testInfo.project.name, 'email-reply-editable.png'),
      fullPage: true,
    });

    await frame.getByRole('button', { name: 'Send' }).click();
    await expect(frame.locator('.done-headline')).toHaveText('Sent', COLD);
    expect(calls).toEqual([
      {
        name: 'outlook_send_draft_confirm',
        arguments: {
          draftId: reply.draftId,
          overrides: {
            to: ['vendor@example.com', 'ap@example.com'],
            subject: 'RE: Invoice 1042 — paid',
            comment: 'Thanks — paid today.',
          },
          replyTo: { messageId: reply.replyTo, kind: 'reply' },
        },
        stateKey: `renkei-email:${reply.draftId}`,
      },
    ]);
  } finally {
    if (modelId) await removeModel(page.request, modelId);
  }
});
