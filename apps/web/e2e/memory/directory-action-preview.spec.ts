/**
 * The ADManager Plus connector's own preview card (directory-action-preview.ts),
 * inside the real chat thread, rendered by the real /api/chat/widgets route
 * from the real built bundle. The person asks in a chat on the stand-in
 * model and the turn runs for real; what ADManager's preview tool would
 * have answered the model with — it needs an ADManager connection the
 * memory server cannot make — is handed to the page as that turn's rows
 * at the stream's browser edge (e2e/support/tool-cards.ts). The confirm
 * button's `tools/call` is answered there too (for real it would reach
 * ADManager); the note and the model's reply after it are real.
 *
 * Two things this card needed to prove beyond widget-card.spec.ts's coverage
 * of the shared preview mechanics (which already covers confirm/cancel/
 * model-context/receipt-recall generically):
 *  - it renders its own person-identity/secret/group-pill shape, not the
 *    generic issue-preview fields list;
 *  - a group list with dozens or hundreds of entries (copying membership
 *    from a long-tenured account) stays inside a bounded, scrollable region
 *    instead of blowing the card past a reviewable height or silently
 *    dropping groups the confirm button is about to act on.
 */

import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { Page, TestInfo } from '@playwright/test';
import { test, expect } from './fixtures';
import { LLM_STUB_REPLY } from './constants';
import { addStubModel, removeModel } from '../support/stub-model';
import { createChat, sendForCards, widgetUri, type ToolCard } from '../support/tool-cards';

const MOBILE_VIEWPORT = { width: 390, height: 844 };
const COLD = { timeout: 30_000 };
const RESULTS = path.join(import.meta.dirname, '..', '..', 'test-results', 'memory');
const PROMPT = 'Give Jane Doe the same groups as Sam Source.';

const DIRECTORY_ACTION_PREVIEW_URI = widgetUri(
  'directory-action-preview.ts',
  'directory-action-preview'
);

// Staging the stand-in model on the roster is an operator's.
test.use({ roles: ['renkei-user', 'renkei-operator'] });

/** 120 plausible AD group names — plenty to prove the pill list scrolls
 *  instead of either dropping entries or stretching the card unusably tall. */
const MANY_GROUPS = Array.from({ length: 120 }, (_, i) => `Dept-${String(i + 1).padStart(3, '0')}`);

const COPY_GROUPS_INPUT = {
  instanceId: 'i1',
  domainName: 'corp.example.com',
  samAccountName: 'jdoe',
  groupNames: MANY_GROUPS,
};

function structuredContent(previewId: string) {
  return {
    kind: 'directory_action',
    previewId,
    action: 'Copy group membership',
    tone: 'neutral',
    title: 'Copy groups from Sam Source to Jane Doe',
    subtitle: 'ADManager Plus prod · corp.example.com',
    person: { name: 'Jane Doe', detail: 'jdoe · corp.example.com' },
    secondaryPerson: { label: 'Copying groups from', name: 'Sam Source', detail: 'ssource' },
    groupLists: [{ label: 'Groups to add', groups: MANY_GROUPS, tone: 'add' }],
    confirmTool: 'admanager_add_user_to_groups_confirm',
    confirmLabel: 'Copy groups',
    confirmArgs: COPY_GROUPS_INPUT,
  };
}

function previewCard(previewId: string): ToolCard {
  return {
    toolUseId: `toolu_dirpreview_${previewId.slice(0, 8)}`,
    tool: 'admanager_copy_group_membership_preview',
    input: {
      instanceId: 'i1',
      domainName: 'corp.example.com',
      targetSam: 'jdoe',
      sourceSam: 'ssource',
    },
    content:
      'The group copy is awaiting the user’s decision on the preview card. ' +
      'Do not write it another way and do not repeat its contents in your reply.',
    uiResourceUri: DIRECTORY_ACTION_PREVIEW_URI,
    structuredContent: structuredContent(previewId),
  };
}

/** A chat of the person's own on the stand-in model, the card shown as the reply. */
async function openCardChat(page: Page, modelId: string, tag: string) {
  const title = `AD directory action (${tag})`;
  const chatId = await createChat(page.request, { modelId, title });
  await page.goto(`/chat/${chatId}`);
  await expect(page.getByRole('heading', { level: 1, name: title })).toBeVisible(COLD);
  await sendForCards(page, {
    chatId,
    modelId,
    prompt: PROMPT,
    assistantText: 'Here’s a preview — nothing changes until you confirm.',
    cards: [previewCard(randomUUID())],
  });
  return chatId;
}

async function shot(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  await page.screenshot({
    path: path.join(RESULTS, 'screens', testInfo.project.name, name),
    fullPage: true,
  });
}

function noteLine(page: Page, text: string) {
  return page.locator('p[title]', { hasText: text });
}

/**
 * The host iframe (widget-card.tsx) sizes itself from `size-changed`
 * messages the card posts after it renders, with its own 120ms CSS
 * transition on top — a check inside the iframe's own document (anything
 * through `frameLocator`) can be satisfied well before that outer element
 * has grown or shrunk to match, which raced a full-page screenshot ahead
 * of the host's resize and clipped a still-growing card. Poll the host
 * element itself so a shot only happens once it has actually caught up.
 */
function cardHeight(page: Page): Promise<number> {
  return page
    .locator('iframe[title="Preview card"]')
    .boundingBox()
    .then((box) => box?.height ?? 0);
}
async function waitForCardHeightAtLeast(page: Page, minHeight: number): Promise<void> {
  await expect.poll(() => cardHeight(page), COLD).toBeGreaterThanOrEqual(minHeight);
}
async function waitForCardHeightBelow(page: Page, maxHeight: number): Promise<void> {
  await expect.poll(() => cardHeight(page), COLD).toBeLessThan(maxHeight);
}

test('a long group list stays inside a bounded, scrollable pane, with every group still confirmed', async ({
  page,
  person: _person,
}, testInfo) => {
  test.setTimeout(150_000);
  const tag = `${testInfo.project.name}-${randomUUID().slice(0, 6)}`;
  const modelId = await addStubModel(page.request, tag);
  try {
    const confirmCall: { value: { name: unknown; arguments: unknown } | null } = { value: null };
    await page.route('**/chat/chats/*/widget/tool-call', async (route) => {
      confirmCall.value = route.request().postDataJSON();
      await route.fulfill({
        json: {
          result: {
            content: [{ type: 'text', text: 'Added Jane Doe to 120 groups.' }],
            isError: false,
            meta: {},
          },
        },
      });
    });

    await openCardChat(page, modelId, tag);

    const frame = page.frameLocator('iframe[title="Preview card"]');
    await expect(frame.locator('.card-title')).toHaveText(
      'Copy groups from Sam Source to Jane Doe',
      COLD
    );
    // The card shows who it's for and who it's copying from — not a
    // generic fields list.
    await expect(frame.locator('.person-name').first()).toHaveText('Jane Doe');
    await expect(frame.locator('.person-name', { hasText: 'Sam Source' })).toBeVisible();
    await expect(frame.getByText('Copying groups from')).toBeVisible();

    // The count is visible without scrolling...
    await expect(frame.getByText('Groups to add')).toBeVisible();
    await expect(frame.locator('.group-count')).toHaveText('(120)');

    // ...and every one of the 120 pills is actually in the DOM (nothing
    // silently dropped to keep the card short) even though only a handful
    // are in view at once.
    const chips = frame.locator('.chip-row .chip');
    await expect(chips).toHaveCount(120);
    await expect(chips.first()).toHaveText('Dept-001');
    await expect(chips.last()).toHaveText('Dept-120');

    // The list is bounded, not free to grow the card past a reviewable
    // height: the pill container's rendered height is capped well short
    // of what 120 wrapped pills would take unclipped.
    const listBox = await frame.locator('.chip-row').boundingBox();
    expect(listBox).not.toBeNull();
    expect(listBox?.height ?? Infinity).toBeLessThan(150);

    const confirmButton = frame.getByRole('button', { name: 'Copy groups' });
    await expect(confirmButton).toBeVisible();
    await waitForCardHeightAtLeast(page, 400);
    await shot(page, testInfo, 'directory-action-preview-groups.png');

    await confirmButton.click();
    await expect(frame.locator('.done-headline')).toHaveText('Added Jane Doe to 120 groups.');
    // The card collapses back down once it's decided, rather than leaving
    // a tall iframe with a two-line receipt floating in blank space below
    // it — bridge.ts's watchSize note documents exactly this failure mode
    // and why it measures document.body's own rendered height (which
    // shrinks with its content) instead of the frame's last-set size.
    await waitForCardHeightBelow(page, 150);
    await shot(page, testInfo, 'directory-action-preview-done.png');

    // The confirm call still carries the full, unclipped list — the
    // scroll region is presentation only.
    expect(confirmCall.value).not.toBeNull();
    expect(confirmCall.value?.name).toBe('admanager_add_user_to_groups_confirm');
    expect(confirmCall.value?.arguments).toMatchObject({ groupNames: MANY_GROUPS });

    const note = noteLine(
      page,
      'The user confirmed "Copy groups from Sam Source to Jane Doe" on the preview card'
    );
    await expect(note).toBeVisible(COLD);
    // The decision opened a turn of its own, and the model answered it.
    await expect(page.getByText(LLM_STUB_REPLY).first()).toBeVisible(COLD);
  } finally {
    await removeModel(page.request, modelId);
  }
});

test('the card still renders at phone width with a long group list', async ({
  page,
  person: _person,
}, testInfo) => {
  test.setTimeout(150_000);
  const tag = `${testInfo.project.name}-${randomUUID().slice(0, 6)}`;
  const modelId = await addStubModel(page.request, tag);
  try {
    await page.setViewportSize(MOBILE_VIEWPORT);
    await openCardChat(page, modelId, tag);

    const frame = page.frameLocator('iframe[title="Preview card"]');
    await expect(frame.locator('.card-title')).toHaveText(
      'Copy groups from Sam Source to Jane Doe',
      COLD
    );
    await expect(frame.locator('.chip-row .chip')).toHaveCount(120);
    await expect(frame.getByRole('button', { name: 'Copy groups' })).toBeVisible(COLD);
    await waitForCardHeightAtLeast(page, 400);
    const bodyWidth = await page.evaluate(() => document.documentElement.scrollWidth);
    expect(bodyWidth).toBeLessThanOrEqual(MOBILE_VIEWPORT.width);
    await shot(page, testInfo, 'directory-action-preview-mobile.png');
  } finally {
    await removeModel(page.request, modelId);
  }
});
