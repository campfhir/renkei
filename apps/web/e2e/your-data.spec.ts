/**
 * Your data, in a browser: the Preferences page's "Your data" section
 * takes pasted text and a Claude export file in, through Preview and
 * Import, to the real memory page and a real chat; its two links save
 * real downloads (the zip and the portable profile) holding what was
 * imported; and the section fits a phone. Real routes, the real delegate
 * sealing memory under the person's key.
 *
 * What each format parses to is lib/data-portability/import-parse.test.ts's;
 * what the routes write, refuse and export is
 * app/api/account/{import,export}/route.test.ts's; when Preview and Import
 * are allowed and what they send is your-data-section.model.test.ts's.
 */

import { readFile } from 'node:fs/promises';
import JSZip from 'jszip';
import { test, expect } from './fixtures';

test('pasted memories import, show on the memory page, and leave in the downloads @smoke', async ({
  page,
  person: _person,
}) => {
  await page.goto('/preferences');
  const section = page.getByRole('region', { name: 'Your data' });
  await expect(section).toBeVisible();

  // ── In: pasted text, previewed, then imported ──
  await section.getByRole('radio', { name: 'Paste text' }).check();
  await section.getByLabel('Text to import').fill('- Lives in Denver\n- Prefers metric units');
  const previewed = page.waitForResponse((r) => r.url().includes('/api/account/import?mode=preview'));
  await section.getByRole('button', { name: 'Preview' }).click();
  expect((await previewed).status()).toBe(200);
  const found = section.getByRole('region', { name: 'What was found' });
  await expect(found).toContainText('Found 2 memories from Markdown.');
  await expect(found.getByRole('listitem').filter({ hasText: 'Lives in Denver' })).toBeVisible();

  const imported = page.waitForResponse((r) => r.url().includes('/api/account/import?mode=import'));
  await found.getByRole('button', { name: 'Import' }).click();
  const answer = await imported;
  expect(answer.status()).toBe(200);
  expect(new URL(answer.url()).searchParams.get('memories')).toBe('1');
  await expect(section.getByRole('status')).toContainText('Imported 2 memories.');

  // ── On the memory page ──
  await section.getByRole('link', { name: 'See your memory' }).click();
  await expect(page).toHaveURL(/\/chat\/memory$/);
  const main = page.getByRole('main');
  await expect(main.getByText('Lives in Denver').filter({ visible: true })).toBeVisible();
  await expect(main.getByText('Prefers metric units').filter({ visible: true })).toBeVisible();

  // ── Out: the zip ──
  await page.goto('/preferences');
  const zipSaved = page.waitForEvent('download');
  await section.getByRole('link', { name: 'Download all my data (.zip)' }).click();
  const zipDownload = await zipSaved;
  expect(zipDownload.suggestedFilename()).toMatch(/^renkei-export-\d{4}-\d{2}-\d{2}\.zip$/);
  const zip = await JSZip.loadAsync(await readFile(await zipDownload.path()));
  const memory: { entries: { content: string }[] } = JSON.parse(
    await zip.file('memory.json')!.async('string')
  );
  expect(memory.entries.map((entry) => entry.content).sort()).toEqual([
    'Lives in Denver',
    'Prefers metric units',
  ]);
  expect(zip.file('README.md')).not.toBeNull();

  // ── Out: the profile for other assistants ──
  const profileSaved = page.waitForEvent('download');
  await section.getByRole('link', { name: 'Download profile for other assistants (.md)' }).click();
  const profileDownload = await profileSaved;
  expect(profileDownload.suggestedFilename()).toMatch(/^renkei-profile-.*\.md$/);
  const profile = await readFile(await profileDownload.path(), 'utf8');
  expect(profile).toMatch(/^# About /);
  expect(profile).toContain('- Lives in Denver');
});

test('a Claude export file imports as a chat that opens like any other', async ({
  page,
  person: _person,
}) => {
  const conversations = [
    {
      name: 'Garden plan',
      created_at: '2026-04-01T10:00:00.000Z',
      chat_messages: [
        { sender: 'human', text: 'When do I plant tomatoes in Denver?' },
        { sender: 'assistant', text: 'After mid-May, once nights stay warm.' },
      ],
    },
  ];
  await page.goto('/preferences');
  const section = page.getByRole('region', { name: 'Your data' });
  await section.getByLabel('File to import').setInputFiles({
    name: 'conversations.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(conversations)),
  });
  await section.getByRole('button', { name: 'Preview' }).click();
  const found = section.getByRole('region', { name: 'What was found' });
  await expect(found).toContainText('Found 1 chat (2 messages) from Claude.');
  // Keep it in the chat list rather than the archive.
  await found.getByRole('checkbox', { name: 'Put imported chats in the archive' }).uncheck();
  const imported = page.waitForResponse((r) => r.url().includes('/api/account/import?mode=import'));
  await found.getByRole('button', { name: 'Import' }).click();
  const answer = await imported;
  expect(new URL(answer.url()).searchParams.get('archive')).toBeNull();
  await expect(section.getByRole('status')).toContainText('Imported 1 chat.');

  const sidebar = await page.request.get('/api/chat/chats');
  const { chats }: { chats: { id: string; title: string | null; archived: boolean }[] } =
    await sidebar.json();
  const chat = chats.find((row) => row.title === 'Garden plan · Claude');
  expect(chat).toBeDefined();
  expect(chat?.archived).toBe(false);

  await page.goto(`/chat/${chat!.id}`);
  const main = page.getByRole('main');
  await expect(
    main.getByText('When do I plant tomatoes in Denver?').filter({ visible: true })
  ).toBeVisible();
  await expect(
    main.getByText('After mid-May, once nights stay warm.').filter({ visible: true })
  ).toBeVisible();
});

test('the section fits a phone', async ({ page, person: _person }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/preferences');
  const section = page.getByRole('region', { name: 'Your data' });
  await section.scrollIntoViewIfNeeded();
  await expect(section.getByRole('link', { name: 'Download all my data (.zip)' })).toBeVisible();
  const box = await section.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.x + box!.width).toBeLessThanOrEqual(390);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)
  ).toBe(true);
});
