/**
 * The global keyboard shortcuts, in a browser: a real key reaching the
 * page brings up the right dialog or page — the quick chat (`c`), the
 * recent-chats switcher (⌘/Ctrl J), a page chord from inside a text field
 * — with the browser's platform faked both ways; the quick chat is the
 * thread's own composer, takes the cursor, and its first turn reaches the
 * server and is answered; closing it unsent deletes the chat it made; it
 * fits a phone; the switcher opens on the chat before this one and Enter
 * goes there; and the shortcuts coach marks follow the welcome tour.
 *
 * What a key means and when it stands down (a modifier held, in a field,
 * over a dialog, the Organization chord only for operators, Control J not
 * the Mac chord), the switcher's order, opening place and walk (the chord
 * again, Shift, the arrows), and what the quick chat sends are
 * global-shortcuts.model.test.ts's; the key caps per OS and the chord
 * matching are lib/shortcuts.test.ts's.
 *
 * Each test presses once the page says its keys are listened for
 * (`data-shortcuts` on the root, naming the keyboard it read), never in a
 * retry loop.
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
import type { Page, TestInfo } from '@playwright/test';
import { test, expect } from './fixtures';
import { LLM_STUB_REPLY } from './constants';
import { addStubModel, removeModel } from './support/stub-model';
import { createPerson, signIn } from './support/person';
import { holdShared } from './support/org-lock';
import { painted, settled } from './support/settle';
import { askAndWait, createChat } from './support/code-host';

// Control+Alt+Shift+, goes to the operator console.
test.use({ roles: ['renkei-user', 'renkei-operator'] });

const RESULTS = path.join(import.meta.dirname, '..', 'test-results');
const MOBILE_VIEWPORT = { width: 390, height: 844 };
async function shot(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  await page.screenshot({
    path: path.join(RESULTS, 'screens', testInfo.project.name, `${name}.png`),
  });
}

type FakePlatform = 'MacIntel' | 'Win32';

/** Pretend to be a Mac (or not) before any page script runs. */
async function fakePlatform(page: Page, platform: FakePlatform): Promise<void> {
  await page.addInitScript((value) => {
    Object.defineProperty(navigator, 'platform', { get: () => value });
    Object.defineProperty(navigator, 'userAgentData', { get: () => undefined });
  }, platform);
}

/** The page has hydrated and listens for the shortcuts of this keyboard. */
async function keysReady(page: Page, platform: FakePlatform): Promise<void> {
  await expect(page.locator('html')).toHaveAttribute(
    'data-shortcuts',
    platform === 'MacIntel' ? 'mac' : 'other',
    { timeout: 30_000 }
  );
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
  const chatId = await createChat(page.request, { llmModelId: modelId });
  await askAndWait(page.request, chatId, { text: `About: ${title}`, llmModelId: modelId });
  // After the reply, which may have named the chat.
  const renamed = await page.request.patch(`/api/chat/chats/${chatId}`, { data: { title } });
  expect(renamed.ok()).toBe(true);
  return chatId;
}

const tagOf = (testInfo: TestInfo) => `${testInfo.project.name}-${randomUUID().slice(0, 6)}`;

test('the search hint shows the key for a Mac', async ({ page, person: _person }, testInfo) => {
  await fakePlatform(page, 'MacIntel');
  await page.goto(`/agents`);
  await expect(page.locator('kbd', { hasText: '⌘ K' })).toBeVisible();
  await shot(page, testInfo, 'shortcuts-hint-mac');
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
    await keysReady(page, 'Win32');
    const dialog = page.getByRole('dialog', { name: 'New chat' });
    await page.keyboard.press('c');
    // A cold dev server compiles the chat routes on this first hit.
    const box = dialog.getByLabel('Message');
    await expect(box).toBeVisible({ timeout: 40_000 });
    await expect(box).toBeFocused();
    // The composer's own controls, not a lookalike.
    await expect(dialog.getByRole('button', { name: 'Attach a file' })).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Insert a prompt' })).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Model' })).toContainText(tag);
    await shot(page, testInfo, 'shortcuts-quick-chat');

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
  await keysReady(page, 'Win32');
  const dialog = page.getByRole('dialog', { name: 'New chat' });
  // The chat the modal makes up front, as its own create call answers it.
  const made = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      new URL(response.url()).pathname === '/api/chat/chats'
  );
  await page.keyboard.press('c');
  await expect(dialog.getByLabel('Message')).toBeVisible({ timeout: 20_000 });
  const { chatId } = await (await made).json();
  expect((await page.request.get(`/api/chat/chats/${chatId}`)).status()).toBe(200);
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect
    .poll(async () => (await page.request.get(`/api/chat/chats/${chatId}`)).status())
    .toBe(404);
});

test('chords use the Command and Option keys on a Mac, and quick chat works at phone width', async ({
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
    await keysReady(page, 'MacIntel');
    const switcher = page.getByRole('dialog', { name: 'Recent chats' });
    await page.keyboard.press('Meta+j');
    await expect(switcher).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(switcher).toHaveCount(0);

    // Option is the Mac's Alt: ⌥ H is Home (the key types "˙", the code is H's).
    await page.keyboard.press('Alt+h');
    await expect(page).toHaveURL(/\/$/);
    await painted(page);

    const dialog = page.getByRole('dialog', { name: 'New chat' });
    await page.keyboard.press('c');
    await expect(dialog.getByLabel('Message')).toBeVisible({ timeout: 20_000 });
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
  await keysReady(page, 'Win32');
  const quick = page.getByRole('dialog', { name: 'New chat' });
  const switcher = page.getByRole('dialog', { name: 'Recent chats' });

  // Over a dialog the bare key does nothing.
  await page.keyboard.press('Control+j');
  await expect(switcher).toBeVisible();
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
});

test('the page chords work from a text field', async ({ page, person: _person }) => {
  await fakePlatform(page, 'Win32');
  await page.goto(`/agents`);
  await keysReady(page, 'Win32');
  const search = page.getByRole('searchbox', { name: 'Search Renkei' });
  await search.click();

  await page.keyboard.press('Alt+p');
  await expect(page).toHaveURL(/\/chat\/projects$/);
  // The operator's console: the role reaches the keys from the server.
  await page.getByRole('searchbox', { name: 'Search Renkei' }).click();
  await page.keyboard.press('Control+Alt+Shift+,');
  await expect(page).toHaveURL(/\/admin$/);
});

test('the switcher opens on the previous chat, and Enter opens it', async ({
  page,
  person: _person,
}, testInfo) => {
  test.setTimeout(180_000);
  const modelId = await addStubModel(page.request, tagOf(testInfo));
  try {
    // Older first: the second is spoken in after the first.
    const older = await makeChat(page, modelId, 'Expense policy question');
    const newest = await makeChat(page, modelId, 'Quarterly report draft');

    await fakePlatform(page, 'Win32');
    await page.goto(`/chat/${newest}`);
    await keysReady(page, 'Win32');
    const dialog = page.getByRole('dialog', { name: 'Recent chats' });
    await page.keyboard.press('Control+j');
    await expect(dialog).toBeVisible();
    const options = dialog.getByRole('option');
    await expect(options.nth(0)).toContainText('Quarterly report draft');
    await expect(options.nth(0)).toContainText('Current');
    await expect(options.nth(1)).toHaveAttribute('aria-selected', 'true');
    await expect(options.nth(1)).toContainText('Expense policy question');
    await shot(page, testInfo, 'shortcuts-switcher');

    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(new RegExp(`/chat/${older}$`));
    await expect(dialog).toHaveCount(0);
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
