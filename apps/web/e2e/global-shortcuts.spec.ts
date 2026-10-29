/**
 * The global keyboard shortcuts, end to end: the key caps match the OS
 * (⌘ on a Mac, Ctrl elsewhere — the browser's platform is faked both ways),
 * the quick-chat modal (`c`) starts a chat from any page with Enter, the
 * recent-chats switcher (⌘/Ctrl J) walks the list and opens a
 * chat, the `c` key stands down in a text field and over a dialog, the ⌥/Alt
 * and ⌘/Ctrl chords go to pages from anywhere, and the shortcuts coach marks follow the welcome tour on
 * the home page.
 *
 * The quick chat's first turn runs for real on the stand-in model
 * (e2e/llm-stub.mjs), staged on the org's roster for the test and removed
 * after; the roster is everybody's, so the composer's model list is
 * narrowed to that one model at the browser edge (the real answer,
 * filtered), and the test can say which model it sent with.
 *
 * A person of its own per test, with the tours off except in the
 * coach-marks test, which signs in one with them on and holds the suite's
 * shared lock on the org-wide tours switch.
 */

import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Locator, Page, TestInfo } from '@playwright/test';
import { test, expect } from './fixtures';
import { LLM_STUB_REPLY } from './constants';
import { addStubModel, removeModel } from './support/stub-model';
import { createPerson, signIn } from './support/person';
import { holdShared } from './support/org-lock';
import { painted, settled } from './support/settle';
import { createChat } from './support/tool-cards';

// Control+Alt+Shift+, goes to the operator console.
test.use({ roles: ['renkei-user', 'renkei-operator'] });

const RESULTS = path.join(import.meta.dirname, '..', 'test-results');
const MOBILE_VIEWPORT = { width: 390, height: 844 };
async function shot(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  await page.screenshot({
    path: path.join(RESULTS, 'screens', testInfo.project.name, `${name}.png`),
  });
}

/** Pretend to be a Mac (or not) before any page script runs. */
async function fakePlatform(page: Page, platform: 'MacIntel' | 'Win32'): Promise<void> {
  await page.addInitScript((value) => {
    Object.defineProperty(navigator, 'platform', { get: () => value });
    Object.defineProperty(navigator, 'userAgentData', { get: () => undefined });
  }, platform);
}

/**
 * Type keys until what they do shows — the first press can land before the
 * page has hydrated. `settle` is how long one try waits for the effect (a
 * bare `c` waits half a second in case an `h` follows).
 */
async function pressUntil(
  page: Page,
  keys: string[],
  seen: () => Promise<void>,
  settle = 1500
): Promise<void> {
  await expect(async () => {
    for (const key of keys) await page.keyboard.press(key);
    await seen();
  }).toPass({ timeout: 20_000, intervals: [settle] });
}

/** Press a shortcut until its dialog is up. */
async function pressUntilOpen(
  page: Page,
  key: string,
  dialog: Locator,
  settle = 1500
): Promise<void> {
  await pressUntil(page, [key], () => expect(dialog).toBeVisible({ timeout: settle }), settle);
}

/** The composer's model list narrowed to one model: the real answer, filtered. */
async function onlyModel(page: Page, modelId: string): Promise<void> {
  await page.route('**/api/chat/composer-setup', async (route) => {
    const real = await route.fetch();
    const body = await real.json();
    const models = Array.isArray(body.models) ? body.models : [];
    await route.fulfill({
      response: real,
      json: { ...body, models: models.filter((model: { id?: unknown }) => model.id === modelId) },
    });
  });
}

/** A chat something was said in (the switcher lists only those), titled. */
async function makeChat(page: Page, modelId: string, title: string): Promise<string> {
  const chatId = await createChat(page.request, { modelId, title });
  const asked = await page.request.post(`/api/chat/chats/${chatId}/turns`, {
    data: { text: `About: ${title}`, llmModelId: modelId },
  });
  expect(asked.status(), await asked.text()).toBe(202);
  // Once the reply is in, the chat takes its title back (a first reply may name it).
  await expect(async () => {
    await page.goto(`/chat/${chatId}`);
    await expect(page.getByText(LLM_STUB_REPLY)).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 45_000 });
  const renamed = await page.request.patch(`/api/chat/chats/${chatId}`, { data: { title } });
  expect(renamed.ok()).toBe(true);
  return chatId;
}

const tagOf = (testInfo: TestInfo) => `${testInfo.project.name}-${randomUUID().slice(0, 6)}`;

test('the search hint shows the key for this OS', async ({ page, person: _person }, testInfo) => {
  await fakePlatform(page, 'MacIntel');
  await page.goto(`/agents`);
  await expect(page.locator('kbd', { hasText: '⌘ K' })).toBeVisible();
  await shot(page, testInfo, 'shortcuts-hint-mac');

  const other = await page.context().newPage();
  await fakePlatform(other, 'Win32');
  await other.goto(`/agents`);
  await expect(other.locator('kbd', { hasText: 'Ctrl K' })).toBeVisible();
});

test('quick chat is the thread composer: attachments, model, prompts, and Enter to start', async ({
  page,
  person: _person,
}, testInfo) => {
  test.setTimeout(120_000);
  const tag = tagOf(testInfo);
  const modelId = await addStubModel(page.request, tag);
  try {
    await fakePlatform(page, 'Win32');
    await onlyModel(page, modelId);
    let sent: { text?: string; attachmentIds?: string[]; llmModelId?: string } | null = null;
    // What Send posts, on its way to the real route.
    await page.route('**/api/chat/chats/*/turns', async (route) => {
      sent = route.request().postDataJSON();
      await route.continue();
    });

    await page.goto(`/agents`);
    const dialog = page.getByRole('dialog', { name: 'New chat' });
    // A cold dev server compiles the chat routes on this first hit.
    await expect(async () => {
      await page.keyboard.press('c');
      await expect(dialog.getByLabel('Message')).toBeVisible({ timeout: 2500 });
    }).toPass({ timeout: 40_000, intervals: [2500] });
    const box = dialog.getByLabel('Message');
    await expect(box).toBeFocused();
    // The composer's own controls, not a lookalike.
    await expect(dialog.getByRole('button', { name: 'Attach a file' })).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Insert a prompt' })).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Model' })).toContainText(tag);
    await shot(page, testInfo, 'shortcuts-quick-chat');

    // Enter with nothing typed does nothing.
    await page.keyboard.press('Enter');
    await expect(dialog).toBeVisible();

    // The prompt picker opens over the box; Escape closes it and only it.
    await dialog.getByRole('button', { name: 'Insert a prompt' }).click();
    const picker = page.getByRole('dialog', { name: 'Insert a prompt' });
    await expect(picker).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(picker).toHaveCount(0);
    await expect(dialog).toBeVisible();

    // A file is uploaded on the new chat and shown as a chip.
    await dialog
      .locator('input[type="file"]')
      .first()
      .setInputFiles({
        name: 'meeting-notes.txt',
        mimeType: 'text/plain',
        buffer: Buffer.from('Decisions: ship on Friday.'),
      });
    await expect(dialog.getByText('meeting-notes.txt')).toBeVisible({ timeout: 20_000 });
    await shot(page, testInfo, 'shortcuts-quick-chat-attached');

    await box.fill('Summarise my week');
    await box.press('Shift+Enter');
    await box.pressSequentially('in three bullets');
    await page.keyboard.press('Enter');

    await expect(page).toHaveURL(/\/chat\/[0-9a-f-]{36}$/, { timeout: 30_000 });
    expect(sent).toEqual(
      expect.objectContaining({
        text: 'Summarise my week\nin three bullets',
        attachmentIds: [expect.any(String)],
        llmModelId: modelId,
      })
    );
    await expect(dialog).toHaveCount(0);
    // The turn is real: the reply comes.
    await expect(page.getByText(LLM_STUB_REPLY)).toBeVisible({ timeout: 45_000 });
  } finally {
    await removeModel(page.request, modelId);
  }
});

test('closing quick chat without sending leaves no empty chat behind', async ({
  page,
  person: _person,
}) => {
  await fakePlatform(page, 'Win32');
  await page.goto(`/agents`);
  const dialog = page.getByRole('dialog', { name: 'New chat' });
  // The chat the modal makes up front, as its own create call answers it.
  const made = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      new URL(response.url()).pathname === '/api/chat/chats'
  );
  await expect(async () => {
    await page.keyboard.press('c');
    await expect(dialog.getByLabel('Message')).toBeVisible({ timeout: 2500 });
  }).toPass({ timeout: 20_000, intervals: [2500] });
  const { chatId } = await (await made).json();
  expect((await page.request.get(`/api/chat/chats/${chatId}`)).status()).toBe(200);
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect
    .poll(async () => (await page.request.get(`/api/chat/chats/${chatId}`)).status())
    .toBe(404);
});

test('chords use the Command key on a Mac, and quick chat works at phone width', async ({
  page,
  person: _person,
}, testInfo) => {
  test.setTimeout(120_000);
  // The composer takes text only with a model to send it with.
  const modelId = await addStubModel(page.request, tagOf(testInfo));
  try {
    await fakePlatform(page, 'MacIntel');
    await onlyModel(page, modelId);
    await page.setViewportSize(MOBILE_VIEWPORT);
    await page.goto(`/agents`);
    const switcher = page.getByRole('dialog', { name: 'Recent chats' });
    await pressUntilOpen(page, 'Meta+j', switcher);
    await page.keyboard.press('Escape');
    await expect(switcher).toHaveCount(0);
    // Control+J is not the Mac chord.
    await page.keyboard.press('Control+j');
    await painted(page);
    await expect(switcher).toHaveCount(0);

    // Option is the Mac's Alt: ⌥ H is Home.
    await pressUntil(page, ['Alt+h'], () => expect(page).toHaveURL(/\/$/, { timeout: 1500 }));

    const dialog = page.getByRole('dialog', { name: 'New chat' });
    // The home page is still loading from the chord: press until it answers.
    await pressUntil(
      page,
      ['c'],
      () => expect(dialog.getByLabel('Message')).toBeVisible({ timeout: 2500 }),
      2500
    );
    const panel = await dialog.locator('> div').boundingBox();
    expect(panel?.x ?? -1).toBeGreaterThanOrEqual(0);
    expect((panel?.x ?? 0) + (panel?.width ?? Infinity)).toBeLessThanOrEqual(MOBILE_VIEWPORT.width);
    await dialog
      .getByLabel('Message')
      .fill('Draft a reply to the vendor about the delayed invoice');
    await shot(page, testInfo, 'shortcuts-quick-chat-phone');
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
  } finally {
    await removeModel(page.request, modelId);
  }
});

test('the `c` key stands down in a field and over a dialog', async ({ page, person: _person }) => {
  await fakePlatform(page, 'Win32');
  await page.goto(`/agents`);
  const quick = page.getByRole('dialog', { name: 'New chat' });
  const switcher = page.getByRole('dialog', { name: 'Recent chats' });

  // Over a dialog the bare key does nothing.
  await pressUntilOpen(page, 'Control+j', switcher);
  await page.keyboard.press('c');
  await painted(page);
  await expect(quick).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(switcher).toHaveCount(0);

  // In a text field it is just a letter.
  const search = page.getByRole('searchbox', { name: 'Search Renkei' });
  await search.click();
  await page.keyboard.type('chat c');
  await painted(page);
  await expect(search).toHaveValue('chat c');
  await expect(page.getByRole('dialog')).toHaveCount(0);

  // Held with a modifier it is not the shortcut either.
  await page.keyboard.press('Escape');
  await search.blur();
  await page.keyboard.press('Alt+c');
  await painted(page);
  await expect(quick).toHaveCount(0);
});

test('the page chords work from a text field, with Alt on Windows and Linux', async ({
  page,
  person: _person,
}) => {
  test.setTimeout(120_000);
  await fakePlatform(page, 'Win32');
  await page.goto(`/agents`);
  const search = page.getByRole('searchbox', { name: 'Search Renkei' });
  await search.click();

  const to = (keys: string, url: RegExp) =>
    pressUntil(page, [keys], () => expect(page).toHaveURL(url, { timeout: 1500 }));
  await to('Alt+p', /\/chat\/projects$/);
  await to('Alt+a', /\/chat\/artifacts$/);
  await to('Alt+Shift+1', /\/notifications$/);
  await to('Alt+,', /\/preferences$/);
  await to('Control+Shift+/', /\/tutorials$/);
  await to('Control+`', /\/code$/);
  await to('Alt+h', /\/$/);
  await to('Control+Alt+Shift+,', /\/admin$/);
});

test('the switcher opens on the previous chat, walks the list and opens one', async ({
  page,
  person: _person,
}, testInfo) => {
  // Opens several pages on a dev server that compiles each on first use.
  test.setTimeout(240_000);
  const modelId = await addStubModel(page.request, tagOf(testInfo));
  try {
    // Oldest first: each one spoken in after the last.
    const oldest = await makeChat(page, modelId, 'Onboarding checklist');
    const middle = await makeChat(page, modelId, 'Expense policy question');
    const newest = await makeChat(page, modelId, 'Quarterly report draft');

    await fakePlatform(page, 'Win32');
    await page.goto(`/chat/${newest}`);
    const dialog = page.getByRole('dialog', { name: 'Recent chats' });
    await pressUntilOpen(page, 'Control+j', dialog);
    const options = dialog.getByRole('option');
    await expect(options.nth(0)).toContainText('Quarterly report draft');
    await expect(options.nth(0)).toContainText('Current');
    // On a chat, the switcher opens on the one before it.
    await expect(options.nth(1)).toHaveAttribute('aria-selected', 'true');
    await expect(options.nth(1)).toContainText('Expense policy question');
    await shot(page, testInfo, 'shortcuts-switcher');

    // Again moves on; Shift goes back.
    await page.keyboard.press('Control+j');
    await expect(options.nth(2)).toHaveAttribute('aria-selected', 'true');
    await page.keyboard.press('Control+Shift+J');
    await expect(options.nth(1)).toHaveAttribute('aria-selected', 'true');
    await page.keyboard.press('ArrowDown');
    await expect(options.nth(2)).toHaveAttribute('aria-selected', 'true');

    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(new RegExp(`/chat/${oldest}$`));
    await expect(dialog).toHaveCount(0);

    // From a page that is not a chat, it opens on the most recent one.
    await page.goto(`/agents`);
    await pressUntilOpen(page, 'Control+j', dialog);
    await expect(dialog.getByRole('option').first()).toHaveAttribute('aria-selected', 'true');
    await expect(dialog.getByRole('option').first()).toContainText('Quarterly report draft');
    await dialog.getByRole('option', { name: /Expense policy/ }).click();
    await expect(page).toHaveURL(new RegExp(`/chat/${middle}$`));
  } finally {
    await removeModel(page.request, modelId);
  }
});

test('the shortcuts coach marks follow the welcome tour on the home page', async ({
  page,
  request,
}, testInfo) => {
  test.setTimeout(120_000);
  // A newcomer with the tours on, so the home page's own tours start.
  const person = await createPerson(request, { coachMarks: true });
  await signIn(page.context(), person);
  const release = await holdShared('tours');
  /** The person's row for one tour, as the coach-mark route reads it back. */
  const statusOf = async (tourId: string) => {
    const response = await page.request.get('/api/coach-marks');
    const body = await response.json();
    const rows: { tourId?: string; status?: string }[] = Array.isArray(body.progress)
      ? body.progress
      : [];
    return rows.find((row) => row.tourId === tourId)?.status;
  };
  try {
    await fakePlatform(page, 'MacIntel');
    const card = page.getByTestId('coach-mark');

    await page.goto(`/`);
    await expect(card).toHaveAttribute('data-coach-tour', 'welcome', { timeout: 30_000 });
    await card.getByRole('button', { name: 'Skip tour' }).click();
    await expect(card).toHaveCount(0);
    // Settled on the server before the page is left, or the tour comes back.
    await expect.poll(() => statusOf('welcome')).toBe('dismissed');

    // The next visit to the home page brings the shortcuts tour.
    await page.goto(`/`);
    await expect(card).toHaveAttribute('data-coach-tour', 'shortcuts');
    await expect(card).toHaveAttribute('data-coach-step', 'search');
    await expect(card).toContainText('⌘ K');
    await expect(page.getByTestId('coach-mark-spotlight')).toBeVisible();
    await settled(page);
    await shot(page, testInfo, 'shortcuts-coach-1-search');

    await card.getByRole('button', { name: 'Next' }).click();
    await expect(card).toHaveAttribute('data-coach-step', 'new-chat');
    await expect(card).toContainText('Press C anywhere');

    await card.getByRole('button', { name: 'Next' }).click();
    await expect(card).toHaveAttribute('data-coach-step', 'switch-chat');
    await expect(card).toContainText('⌘ J');
    await settled(page);
    await shot(page, testInfo, 'shortcuts-coach-3-switch');

    await card.getByRole('button', { name: 'Next' }).click();
    await expect(card).toHaveAttribute('data-coach-step', 'go-to');
    await expect(card).toContainText('⌥ H');
    await expect(card).toContainText('⌥ ,');
    await settled(page);
    await shot(page, testInfo, 'shortcuts-coach-4-go-to');

    await card.getByRole('button', { name: 'Finish' }).click();
    await expect(card).toHaveCount(0);
    await expect.poll(() => statusOf('shortcuts')).toBe('completed');
  } finally {
    await release();
  }
});
