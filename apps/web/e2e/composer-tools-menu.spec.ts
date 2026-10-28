/**
 * The composer row of a code project at phone width: prompt libraries, the
 * microphone and the speaker fold into one button with a two-level menu
 * (composer-tools-menu.tsx) so the model and Auto switch keep their room.
 * Driven end to end: the first level, Prompt libraries opening the picker,
 * Dictate turning the button into the microphone (and one tap stopping
 * it), and Voice opening the speaker panel as the second level with a way
 * back. Also that the row fits the screen, and that at desktop width the
 * separate buttons are still there and the merged one is not.
 *
 * "Phone width" is a resized Chromium viewport, not a device descriptor.
 * The code project and its chat are the test's own person's
 * (e2e/support/code-host.ts); the speech service and the person's voice
 * are staged as e2e/support/voice.ts stages them, the vendor answered at
 * the browser edge, and the microphone is Chromium's fake device.
 */

import { randomUUID } from 'node:crypto';
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures';
import { removeModel } from './support/stub-model';
import { createChat, createCodeProject, setUpCode } from './support/code-host';
import { VOICE_PREFS, enableVoiceService, mockVendor, shot } from './support/voice';

const MOBILE_VIEWPORT = { width: 390, height: 844 };

test.use({
  // The speech service, the code host and the chat's model are an operator's to stage.
  roles: ['renkei-user', 'renkei-operator'],
  permissions: ['microphone'],
  browserName: 'chromium',
  launchOptions: {
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE,
    args: [
      '--no-sandbox',
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      '--autoplay-policy=no-user-gesture-required',
    ],
  },
});

let chatId = '';
let modelId = '';

test.beforeEach(async ({ page, request, person: _person }, testInfo) => {
  // A built app may take a while to offer a speech service just switched on.
  test.slow();
  const tag = `${testInfo.project.name}-${randomUUID().slice(0, 6)}`;
  await enableVoiceService(page.request);
  const prefs = await page.request.put('/api/preferences', { data: { voice: VOICE_PREFS } });
  expect(prefs.ok(), await prefs.text()).toBe(true);
  modelId = await setUpCode(page, request, tag);
  const projectId = await createCodeProject(page.request, {
    name: `Tools menu service (${tag})`,
    repository: 'acme/tools-menu',
    branch: 'main',
    description: 'A code project.',
  });
  chatId = await createChat(page.request, {
    projectId,
    title: `Which endpoint posts refunds? (${tag})`,
    llmModelId: modelId,
  });
  // Each server bundle caches the org's connector settings for a minute:
  // wait until the chat offers voice — with the code pane put away, which
  // opens beside a code chat on a wide screen and narrows its composer.
  await expect(async () => {
    await page.goto(`/chat/${chatId}`);
    await hideCode(page);
    await expect(page.getByRole('button', { name: 'Voice', exact: true })).toBeVisible({
      timeout: 5_000,
    });
  }).toPass({ timeout: 90_000, intervals: [2_000, 5_000] });
});

async function hideCode(page: Page): Promise<void> {
  const hide = page.getByRole('button', { name: 'Hide the code' });
  await expect(page.getByLabel('Message')).toBeVisible({ timeout: 30_000 });
  if (await hide.isVisible()) await hide.click();
}

test.afterEach(async ({ page }) => {
  await removeModel(page.request, modelId);
});

async function openChat(page: Page): Promise<void> {
  await mockVendor(page);
  await page.goto(`/chat/${chatId}`);
  await expect(page.getByLabel('Message')).toBeVisible();
  // The dev server's floating "N" badge sits over the composer's left edge
  // at phone width, swallowing clicks and hiding the very buttons under test.
  await page.addStyleTag({ content: 'nextjs-portal { display: none !important; }' });
}

/** Every control in the composer's bottom row sits inside the screen. */
async function expectRowFits(page: Page): Promise<void> {
  const viewport = page.viewportSize() ?? MOBILE_VIEWPORT;
  const box = await page.getByLabel('Message').boundingBox();
  const send = await page.getByRole('button', { name: 'Send' }).boundingBox();
  expect(box).not.toBeNull();
  expect((send?.x ?? 0) + (send?.width ?? 0)).toBeLessThanOrEqual(viewport.width);
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth
  );
  expect(overflow).toBeLessThanOrEqual(0);
}

test('phone: prompts, dictation and voice fold into one two-level menu', async ({
  page,
}, testInfo) => {
  await page.setViewportSize(MOBILE_VIEWPORT);
  await openChat(page);

  // One button stands in for three; the separate ones are not on screen.
  const tools = page.getByRole('button', { name: 'Prompts and voice' });
  await expect(tools).toBeVisible();
  await expect(page.getByRole('button', { name: 'Insert a prompt' })).toBeHidden();
  await expect(page.getByRole('button', { name: 'Dictate', exact: true })).toBeHidden();
  await expect(page.getByRole('button', { name: 'Voice', exact: true })).toBeHidden();
  // The model and Auto switch are still there beside it.
  await expect(page.getByRole('button', { name: /Auto/ })).toBeVisible();
  await expectRowFits(page);
  await shot(page, testInfo, 'tools-menu-01-row', false);

  // First level.
  await tools.click();
  const menu = page.getByRole('menu', { name: 'Prompts and voice' });
  await expect(menu.getByRole('menuitem', { name: 'Prompt libraries' })).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: 'Dictate' })).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: 'Voice' })).toBeVisible();
  await shot(page, testInfo, 'tools-menu-02-first-level', false);

  // Second level: the voice panel, and back.
  await menu.getByRole('menuitem', { name: 'Voice' }).click();
  await expect(menu).toBeHidden();
  await expect(page.getByRole('combobox').filter({ hasText: 'Sonia' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Close voice menu' })).toBeVisible();
  const panel = await page.getByRole('menu').boundingBox();
  expect(panel?.x ?? -1).toBeGreaterThanOrEqual(0);
  expect((panel?.x ?? 0) + (panel?.width ?? Infinity)).toBeLessThanOrEqual(MOBILE_VIEWPORT.width);
  await shot(page, testInfo, 'tools-menu-03-voice-level', false);
  await page.getByRole('button', { name: 'Back to tools' }).click();
  await expect(menu).toBeVisible();

  // Prompt libraries opens the picker and closes the menu.
  await menu.getByRole('menuitem', { name: 'Prompt libraries' }).click();
  await expect(menu).toBeHidden();
  await expect(page.getByRole('dialog', { name: 'Insert a prompt' })).toBeVisible();
  await shot(page, testInfo, 'tools-menu-04-prompts', false);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: 'Insert a prompt' })).toBeHidden();

  // Dictate: the button becomes the microphone, and one tap stops it.
  await tools.click();
  await menu.getByRole('menuitem', { name: 'Dictate' }).click();
  await expect(page.getByLabel('Message')).toHaveAttribute('placeholder', /Speak, then pause/);
  const stop = page.getByRole('button', { name: 'Stop dictating' });
  await expect(stop).toBeVisible();
  await shot(page, testInfo, 'tools-menu-05-dictating', false);
  await stop.click();
  await expect(page.getByRole('button', { name: 'Prompts and voice' })).toBeVisible();
  await expect(page.getByLabel('Message')).not.toHaveAttribute('placeholder', /Speak, then pause/);
});

test('phone: the voice conversation is reachable and Escape closes the menu', async ({ page }) => {
  await page.setViewportSize(MOBILE_VIEWPORT);
  await openChat(page);
  await page.getByRole('button', { name: 'Prompts and voice' }).click();
  await page.getByRole('menuitem', { name: 'Voice' }).click();
  await page.getByRole('menuitem', { name: /Start a voice conversation/ }).click();
  await expect(page.getByRole('dialog', { name: 'Voice conversation' })).toBeVisible();
  await expect(page.getByRole('menu')).toBeHidden();
});

test('phone: Escape closes the tools menu', async ({ page }) => {
  await page.setViewportSize(MOBILE_VIEWPORT);
  await openChat(page);
  await page.getByRole('button', { name: 'Prompts and voice' }).click();
  await expect(page.getByRole('menu')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('menu')).toBeHidden();
});

test('desktop: the separate buttons stay, the merged one is not there', async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await openChat(page);
  await hideCode(page);
  await expect(page.getByRole('button', { name: 'Insert a prompt' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Dictate', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Voice', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Prompts and voice' })).toBeHidden();
  await shot(page, testInfo, 'tools-menu-06-desktop-row', false);
});
