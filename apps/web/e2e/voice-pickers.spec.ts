/**
 * The language and voice pickers (chat/_components/voice-picker.tsx) as a
 * person sees them: closed, open, mid-search, and with a voice being
 * tried out — in the composer's speaker menu and on the Preferences page,
 * a screenshot at each step. The vendor is answered at the browser edge
 * (e2e/support/voice.ts), so the catalog is the fixture's eleven voices in
 * seven languages and a sample is a silent WAV.
 *
 * The rules moved to chat/_components/voice-picker.model.test.ts: the
 * order of the groups, what a search finds ("warm", "japan", "deutsch"),
 * what the closed picker shows, the keyboard's walk of the rows, and that
 * a voice of another language brings its language along. What stays here
 * is only a browser's: the lists drawn on the real page, a sample really
 * playing (its row's Stop), and Escape closing the picker but not the
 * speaker menu it sits in.
 */

import { randomUUID } from 'node:crypto';
import { test, expect } from './fixtures';
import { removeModel } from './support/stub-model';
import { CHAT_TITLE, mockVendor, shot, stageVoice, type VoiceChat } from './support/voice';

test.use({
  // The speech service and the chat's model are an operator's to stage.
  roles: ['renkei-user', 'renkei-operator'],
  browserName: 'chromium',
  launchOptions: {
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE,
    args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'],
  },
});

let voice: VoiceChat;

test.beforeEach(async ({ page, person: _person }, testInfo) => {
  voice = await stageVoice(page.request, `${testInfo.project.name}-${randomUUID().slice(0, 6)}`);
});

test.afterEach(async ({ page }) => {
  await removeModel(page.request, voice.modelId);
});

test('preferences: the language and voice pickers', async ({ page }, testInfo) => {
  await mockVendor(page);
  await page.goto(`/preferences`);
  const section = page.getByRole('region', { name: 'Voice' });
  await expect(section.getByRole('combobox', { name: 'Voice' })).toContainText('Sonia');
  await section.scrollIntoViewIfNeeded();
  await shot(page, testInfo, 'pickers-01-preferences-closed', false);

  await section.getByRole('combobox', { name: 'Voice' }).click();
  const voices = page.getByRole('listbox', { name: 'Voice' });
  await expect(voices.getByText('Calm, pleasant · narration, news')).toBeVisible();
  await shot(page, testInfo, 'pickers-02-preferences-voices-open', false);

  await page.getByRole('searchbox', { name: 'Search voice' }).fill('warm');
  await expect(voices.getByText('Sonia')).toHaveCount(0);
  await shot(page, testInfo, 'pickers-03-preferences-voices-search-warm', false);

  // Trying a voice: the row shows Stop while its sample plays.
  await voices.getByRole('button', { name: 'Hear Xiaoxiao (晓晓)' }).click();
  await expect(voices.getByRole('button', { name: 'Stop Xiaoxiao (晓晓)' })).toBeVisible();
  await shot(page, testInfo, 'pickers-04-preferences-voice-playing', false);

  // Choosing it: the picker closes on the choice (and the language
  // follows it, which the model test holds).
  await voices.getByText('Xiaoxiao (晓晓)').click();
  await expect(section.getByRole('combobox', { name: 'Voice' })).toContainText('Xiaoxiao');
  await shot(page, testInfo, 'pickers-05-preferences-chinese-chosen', false);

  await section.getByRole('combobox', { name: 'Language' }).click();
  const languages = page.getByRole('listbox', { name: 'Language' });
  await expect(languages.getByRole('group', { name: 'English' })).toBeVisible();
  await shot(page, testInfo, 'pickers-06-preferences-languages-open', false);
  await page.getByRole('searchbox', { name: 'Search language' }).fill('deutsch');
  await expect(languages.getByText('Germany')).toBeVisible();
  await shot(page, testInfo, 'pickers-07-preferences-languages-search-deutsch', false);
  await page.keyboard.press('Escape');
  await expect(languages).toHaveCount(0);
});

test('chat: the pickers in the speaker menu', async ({ page }, testInfo) => {
  await mockVendor(page);
  await page.goto(`/chat/${voice.chatId}`);
  await expect(page.getByRole('heading', { level: 1, name: CHAT_TITLE })).toBeVisible();

  await page.getByRole('button', { name: 'Voice', exact: true }).click();
  const menu = page.getByRole('menu');
  await expect(menu).toBeVisible();
  await expect(menu.getByRole('combobox', { name: 'Voice' })).toContainText('Sonia');
  await expect(menu.getByRole('button', { name: 'Hear' })).toBeVisible();
  await shot(page, testInfo, 'pickers-08-chat-menu-closed', false);

  await menu.getByRole('combobox', { name: 'Voice' }).click();
  const voices = page.getByRole('listbox', { name: 'Voice' });
  await expect(voices).toBeVisible();
  await shot(page, testInfo, 'pickers-09-chat-voices-open', false);

  // Escape closes the picker, not the menu around it.
  await page.getByRole('searchbox', { name: 'Search voice' }).fill('japan');
  await expect(voices.getByText('Nanami (七海)')).toBeVisible();
  await shot(page, testInfo, 'pickers-10-chat-voices-search-japan', false);
  await page.keyboard.press('Escape');
  await expect(voices).toHaveCount(0);
  await expect(menu).toBeVisible();

  // Hear, beside the voice: the chosen voice says its sentence.
  await menu.getByRole('button', { name: 'Hear' }).click();
  await expect(menu.getByRole('button', { name: 'Stop' })).toBeVisible();
  await shot(page, testInfo, 'pickers-11-chat-hearing-sample', false);

  await menu.getByRole('combobox', { name: 'Language' }).click();
  const languages = page.getByRole('listbox', { name: 'Language' });
  await expect(languages).toBeVisible();
  await shot(page, testInfo, 'pickers-12-chat-languages-open', false);
});
