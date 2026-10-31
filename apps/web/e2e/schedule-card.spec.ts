/**
 * Scheduling on the email send card: "Send later" turns Send into Schedule
 * and hands the confirm tool a `sendAt`; a time too soon is refused on the
 * card before any call.
 *
 * Same harness as email-card-discard.spec.ts: the real built bundle and
 * decision routes, a chat on the stand-in model, the vendor tool's answer
 * and the card's `tools/call` reply handed over at the browser edge.
 */

import { randomUUID } from 'node:crypto';
import type { Page, TestInfo } from '@playwright/test';
import { test, expect } from './fixtures';
import { addStubModel, removeModel } from './support/stub-model';
import { createChat, sendForCards, widgetUri, type ToolCard } from './support/tool-cards';

const COLD = { timeout: 30_000 };
const EMAIL_COMPOSE_URI = widgetUri('email-compose.ts', 'email-compose');

test.use({ roles: ['renkei-user', 'renkei-operator'] });

/** A moment as the viewer's local day and clock time, as the two Send later inputs hold them. */
function localParts(ms: number): { day: string; clock: string } {
  const iso = new Date(ms - new Date(ms).getTimezoneOffset() * 60_000).toISOString();
  return { day: iso.slice(0, 10), clock: iso.slice(11, 16) };
}

interface CardCall {
  name: string;
  arguments: Record<string, unknown>;
}

function emailCard(draftId: string): ToolCard {
  return {
    toolUseId: `toolu_${randomUUID().slice(0, 8)}`,
    tool: 'outlook_send_mail_preview',
    input: { to: ['vendor@example.com'], subject: 'Invoice question', body: 'About 1042.' },
    content: 'The email is drafted and awaiting the user’s decision on the preview card.',
    uiResourceUri: EMAIL_COMPOSE_URI,
    structuredContent: {
      kind: 'compose',
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

async function openChat(page: Page, testInfo: TestInfo, card: ToolCard): Promise<string> {
  const tag = `${testInfo.project.name}-${randomUUID().slice(0, 6)}`;
  const modelId = await addStubModel(page.request, tag);
  const title = `Schedule (${tag})`;
  const chatId = await createChat(page.request, { modelId, title });
  await page.goto(`/chat/${chatId}`);
  await expect(page.getByRole('heading', { level: 1, name: title })).toBeVisible(COLD);
  await sendForCards(page, {
    modelId,
    chatId,
    prompt: 'Email the vendor.',
    assistantText: 'Here’s the draft — nothing is sent until you confirm.',
    cards: [card],
  });
  return modelId;
}

/** Stand in for Graph: every card tool call succeeds. Returns what the card called. */
async function mockCardTools(page: Page): Promise<CardCall[]> {
  const calls: CardCall[] = [];
  await page.route('**/chat/chats/*/widget/tool-call', async (route) => {
    calls.push(route.request().postDataJSON());
    await route.fulfill({ json: { result: { content: [{ type: 'text', text: 'Done.' }] } } });
  });
  return calls;
}

test('a time the model picked is pre-filled into Send later, and Schedule sends it', async ({
  page,
  person: _person,
}, testInfo) => {
  test.setTimeout(150_000);
  let modelId: string | null = null;
  try {
    // The preview tool's sendAt, a whole minute ahead, as the card receives it.
    const at = new Date(Math.ceil((Date.now() + 26 * 3_600_000) / 60_000) * 60_000);
    const card = emailCard('AAMkAD-suggested');
    card.structuredContent = { ...card.structuredContent, sendAt: at.toISOString() };
    modelId = await openChat(page, testInfo, card);
    const calls = await mockCardTools(page);
    const frame = page.frameLocator('iframe[title="Preview card"]').first();

    // The picker shows the moment in the viewer's own clock, and the button says Schedule.
    const day = frame.locator('input[type="date"]');
    const clock = frame.locator('input[type="time"]');
    const parts = localParts(at.getTime());
    await expect(day).toHaveValue(parts.day, COLD);
    await expect(clock).toHaveValue(parts.clock);
    await expect(frame.getByRole('button', { name: 'Schedule' })).toBeVisible(COLD);
    // Under 16px, iOS Safari zooms the page in when a field is focused.
    for (const input of [day, clock]) {
      expect(await input.evaluate((el) => getComputedStyle(el).fontSize)).toBe('16px');
    }

    await frame.getByRole('button', { name: 'Schedule' }).click();
    await expect(frame.locator('.done-headline')).toHaveText('Scheduled', COLD);
    expect(calls).toHaveLength(1);
    expect(Date.parse(String(calls[0].arguments.sendAt))).toBe(at.getTime());
  } finally {
    if (modelId) await removeModel(page.request, modelId);
  }
});

test('on a phone the card and its fields stay inside the screen, with no sideways scroll', async ({
  page,
  person: _person,
}, testInfo) => {
  test.setTimeout(150_000);
  let modelId: string | null = null;
  try {
    await page.setViewportSize({ width: 390, height: 844 });
    const at = new Date(Math.ceil((Date.now() + 26 * 3_600_000) / 60_000) * 60_000);
    const card = emailCard('AAMkAD-phone');
    card.structuredContent = { ...card.structuredContent, sendAt: at.toISOString() };
    modelId = await openChat(page, testInfo, card);
    const frame = page.frameLocator('iframe[title="Preview card"]').first();
    await expect(frame.getByRole('button', { name: 'Schedule' })).toBeVisible(COLD);

    const fit = await frame.locator('html').evaluate((html) => {
      const box = (el: Element) => el.getBoundingClientRect();
      const cardEl = html.querySelector('.card');
      if (!cardEl) return { error: 'no card' };
      const cardBox = box(cardEl);
      const fields = [...html.querySelectorAll('.field input, .field textarea, .field select, .field-value')];
      const overflowing = fields
        .filter((f) => {
          const b = box(f);
          return b.right > cardBox.right + 0.5 || b.left < cardBox.left - 0.5;
        })
        .map((f) => f.outerHTML.slice(0, 80));
      return {
        overflowing,
        pageScrolls: html.scrollWidth > html.clientWidth + 0.5,
        cardWidth: cardBox.width,
        viewport: html.clientWidth,
      };
    });
    expect(fit).toEqual({
      overflowing: [],
      pageScrolls: false,
      cardWidth: expect.any(Number),
      viewport: expect.any(Number),
    });
    expect((fit as { cardWidth: number }).cardWidth).toBeLessThanOrEqual(
      (fit as { viewport: number }).viewport
    );
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
    modelId = await openChat(page, testInfo, emailCard('AAMkAD-send'));
    const calls = await mockCardTools(page);
    const frame = page.frameLocator('iframe[title="Preview card"]').first();
    await expect(frame.getByRole('button', { name: 'Send', exact: true })).toBeVisible(COLD);

    const day = frame.locator('input[type="date"]');
    const clock = frame.locator('input[type="time"]');
    // Too soon is refused on the card, before any call.
    const past = localParts(Date.now() - 3_600_000);
    await day.fill(past.day);
    await clock.fill(past.clock);
    await frame.getByRole('button', { name: 'Schedule' }).click();
    await expect(frame.getByText('at least a minute from now')).toBeVisible(COLD);
    expect(calls).toHaveLength(0);

    const later = localParts(Date.now() + 26 * 3_600_000);
    await day.fill(later.day);
    await clock.fill(later.clock);
    await frame.getByRole('button', { name: 'Schedule' }).click();
    await expect(frame.locator('.done-headline')).toHaveText('Scheduled', COLD);
    expect(calls).toHaveLength(1);
    expect(calls[0].name).toBe('outlook_send_draft_confirm');
    expect(Date.parse(String(calls[0].arguments.sendAt))).toBe(new Date(`${later.day}T${later.clock}`).getTime());
  } finally {
    if (modelId) await removeModel(page.request, modelId);
  }
});
