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
 * "Phone width" is a resized Chromium viewport, not the `mobile` project's
 * device descriptor (see AGENTS.md's "UI changes"). The voice vendor is
 * answered at the browser edge (voice-fixtures.ts) and the microphone is
 * Chromium's fake device; the fixtures seeded per project so parallel
 * projects don't share a row.
 */

import { test, expect, type Page } from '@playwright/test';
import { Client } from 'pg';
import { E2E_SLUG, E2E_SUBJECT, E2E_TENANT_ID } from './seed';
import { MODEL_ID, mockVendor, seedVoice, shot } from './voice-fixtures';

const MOBILE_VIEWPORT = { width: 390, height: 844 };

test.use({
  permissions: ['microphone'],
  browserName: 'chromium',
  launchOptions: {
    executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    args: [
      '--no-sandbox',
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      '--autoplay-policy=no-user-gesture-required',
    ],
  },
});

function idsFor(project: string) {
  const digit = { 'desktop-light': '1', 'desktop-dark': '2', mobile: '3' }[project] ?? '4';
  return {
    projectId: `79797979-7979-4797-8797-7979797979${digit}1`,
    chatId: `79797979-7979-4797-8797-7979797979${digit}2`,
    projectName: `Tools menu service (${digit})`,
    chatTitle: `Which endpoint posts refunds? (${digit})`,
  };
}

test.beforeEach(async ({ browserName: _browser }, testInfo) => {
  const ids = idsFor(testInfo.project.name);
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    await seedVoice(client);
    await client.query('DELETE FROM chats WHERE project_id = $1', [ids.projectId]);
    await client.query('DELETE FROM chat_projects WHERE id = $1', [ids.projectId]);
    await client.query(
      `INSERT INTO chat_projects
         (id, tenant_id, owner_subject, name, description, kind, repo_provider, repo_full_name, repo_branch)
       VALUES ($1, $2, $3, $4, 'A code project.', 'code', 'atlassian-bitbucket', 'acme/tools-menu', 'main')`,
      [ids.projectId, E2E_TENANT_ID, E2E_SUBJECT, ids.projectName]
    );
    await client.query(
      `INSERT INTO chats (id, tenant_id, owner_subject, project_id, title, llm_model_id, last_message_at)
       VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
      [ids.chatId, E2E_TENANT_ID, E2E_SUBJECT, ids.projectId, ids.chatTitle, MODEL_ID]
    );
    await client.query('UPDATE chat_projects SET active_chat_id = $1 WHERE id = $2', [
      ids.chatId,
      ids.projectId,
    ]);
  } finally {
    await client.end();
  }
});

async function openChat(page: Page, project: string): Promise<void> {
  const ids = idsFor(project);
  await mockVendor(page);
  await page.goto(`/${E2E_SLUG}/chat/${ids.chatId}`);
  await expect(page.getByLabel('Message')).toBeVisible();
  // The dev server's floating "N" badge sits over the composer's left edge
  // at phone width, swallowing clicks and hiding the very buttons under test.
  await page.addStyleTag({ content: 'nextjs-portal { display: none !important; }' });
}

/** Every control in the composer's bottom row sits inside the screen. */
async function expectRowFits(page: Page): Promise<void> {
  const viewport = page.viewportSize()!;
  const box = await page.getByLabel('Message').boundingBox();
  const send = await page.getByRole('button', { name: 'Send' }).boundingBox();
  expect(box).not.toBeNull();
  expect(send!.x + send!.width).toBeLessThanOrEqual(viewport.width);
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth
  );
  expect(overflow).toBeLessThanOrEqual(0);
}

test('phone: prompts, dictation and voice fold into one two-level menu', async ({
  page,
}, testInfo) => {
  await page.setViewportSize(MOBILE_VIEWPORT);
  await openChat(page, testInfo.project.name);

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
  expect(panel!.x).toBeGreaterThanOrEqual(0);
  expect(panel!.x + panel!.width).toBeLessThanOrEqual(MOBILE_VIEWPORT.width);
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

test('phone: the voice conversation is reachable and Escape closes the menu', async ({
  page,
}, testInfo) => {
  await page.setViewportSize(MOBILE_VIEWPORT);
  await openChat(page, testInfo.project.name);
  await page.getByRole('button', { name: 'Prompts and voice' }).click();
  await page.getByRole('menuitem', { name: 'Voice' }).click();
  await page.getByRole('menuitem', { name: /Start a voice conversation/ }).click();
  await expect(page.getByRole('dialog', { name: 'Voice conversation' })).toBeVisible();
  await expect(page.getByRole('menu')).toBeHidden();
});

test('phone: Escape closes the tools menu', async ({ page }, testInfo) => {
  await page.setViewportSize(MOBILE_VIEWPORT);
  await openChat(page, testInfo.project.name);
  await page.getByRole('button', { name: 'Prompts and voice' }).click();
  await expect(page.getByRole('menu')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('menu')).toBeHidden();
});

test('desktop: the separate buttons stay, the merged one is not there', async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await openChat(page, testInfo.project.name);
  await expect(page.getByRole('button', { name: 'Insert a prompt' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Dictate', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Voice', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Prompts and voice' })).toBeHidden();
  await shot(page, testInfo, 'tools-menu-06-desktop-row', false);
});
