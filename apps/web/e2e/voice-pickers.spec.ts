/**
 * The language and voice pickers (chat/_components/voice-picker.tsx) as a
 * person meets them: closed, open with their groups, mid-search, and with
 * a voice being tried out — in the composer's speaker menu and on the
 * Preferences page, at desktop and phone sizes. The vendor is answered at
 * the browser edge (voice-fixtures.ts), so the catalog is the fixture's
 * eleven voices in seven languages and a sample is a silent WAV.
 */

import { test, expect } from '@playwright/test';
import { Client } from 'pg';
import { E2E_SLUG } from './seed';
import { CHAT_ID, CHAT_TITLE, mockVendor, seedVoice, shot } from './voice-fixtures';

test.use({
  browserName: 'chromium',
  launchOptions: {
    executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'],
  },
});

test.beforeAll(async () => {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    await seedVoice(client);
  } finally {
    await client.end();
  }
});

test('preferences: the language and voice pickers', async ({ page }, testInfo) => {
  await mockVendor(page);
  await page.goto(`/${E2E_SLUG}/preferences`);
  const section = page.getByRole('region', { name: 'Voice' });
  await expect(section.getByRole('combobox', { name: 'Voice' })).toContainText('Sonia');
  await section.scrollIntoViewIfNeeded();
  await shot(page, testInfo, 'pickers-01-preferences-closed', false);

  // The voice list: the chosen language's voices first, then the rest of
  // English, then every other language, each with the vendor's word on it.
  await section.getByRole('combobox', { name: 'Voice' }).click();
  const voices = page.getByRole('listbox', { name: 'Voice' });
  await expect(voices).toBeVisible();
  await expect(voices.getByRole('group', { name: /English · United Kingdom/ })).toBeVisible();
  await expect(voices.getByText('Calm, pleasant · narration, news')).toBeVisible();
  await shot(page, testInfo, 'pickers-02-preferences-voices-open', false);

  // Searching by a word of a description, across every language.
  await page.getByRole('searchbox', { name: 'Search voice' }).fill('warm');
  await expect(voices.getByRole('option')).toHaveCount(3);
  await expect(voices.getByText('Nanami (七海)')).toBeVisible();
  await expect(voices.getByText('Xiaoxiao (晓晓)')).toBeVisible();
  await shot(page, testInfo, 'pickers-03-preferences-voices-search-warm', false);

  // Trying a Chinese voice: the sample is Chinese, and the row shows Stop
  // while it plays.
  await voices.getByRole('button', { name: 'Hear Xiaoxiao (晓晓)' }).click();
  await expect(voices.getByRole('button', { name: 'Stop Xiaoxiao (晓晓)' })).toBeVisible();
  await shot(page, testInfo, 'pickers-04-preferences-voice-playing', false);

  // Choosing it brings Chinese along as the language.
  await voices.getByText('Xiaoxiao (晓晓)').click();
  await expect(section.getByRole('combobox', { name: 'Voice' })).toContainText('Xiaoxiao');
  await expect(section.getByRole('combobox', { name: 'Language' })).toContainText('zh-CN');
  await expect(section.getByRole('button', { name: /Hear a sample in Chinese/ })).toBeVisible();
  await shot(page, testInfo, 'pickers-05-preferences-chinese-chosen', false);

  // The language list: regions under their language, Chinese now first;
  // searching by a language's own name.
  await section.getByRole('combobox', { name: 'Language' }).click();
  const languages = page.getByRole('listbox', { name: 'Language' });
  await expect(languages).toBeVisible();
  await expect(languages.getByRole('group').first()).toHaveAccessibleName('Chinese');
  await expect(languages.getByRole('group', { name: 'English' })).toBeVisible();
  await shot(page, testInfo, 'pickers-06-preferences-languages-open', false);
  await page.getByRole('searchbox', { name: 'Search language' }).fill('deutsch');
  await expect(languages.getByRole('option')).toHaveCount(1);
  await expect(languages.getByText('Germany')).toBeVisible();
  await shot(page, testInfo, 'pickers-07-preferences-languages-search-deutsch', false);
  await page.keyboard.press('Escape');
  await expect(languages).toHaveCount(0);
});

test('chat: the pickers in the speaker menu', async ({ page }, testInfo) => {
  await mockVendor(page);
  await page.goto(`/${E2E_SLUG}/chat/${CHAT_ID}`);
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

  // A country finds its voices; Escape closes the picker, not the menu.
  await page.getByRole('searchbox', { name: 'Search voice' }).fill('japan');
  await expect(voices.getByRole('option')).toHaveCount(1);
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
