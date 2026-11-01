/**
 * The "Archive old chats" preference in a browser: the section renders on
 * the preferences page, one save goes end to end (a window typed, Save
 * pressed, the PUT reaching /api/preferences, "Saved." drawn, and a reload
 * reading it back), and the field and its note fit a phone's width.
 *
 * Where the rest went: the form's rules (empty is never, Save off until the
 * entry changes, a fraction or a window longer than the organization keeps
 * chats refused before it leaves the page, the refusal's words, the note
 * under the field) are preferences/chat-archive-form.model.test.ts; the
 * server's (the same over-long window refused with a 400, null back to
 * never, the stored value read back) are app/api/preferences/route.test.ts.
 * The sweep that archives chats runs in the worker, not here.
 */

import path from 'node:path';
import type { Page, TestInfo } from '@playwright/test';
import { test, expect } from './fixtures';

const RESULTS = path.join(import.meta.dirname, '..', 'test-results');
const MOBILE_VIEWPORT = { width: 390, height: 844 };

async function shot(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  await page.screenshot({
    path: path.join(RESULTS, 'screens', testInfo.project.name, `${name}.png`),
    fullPage: true,
  });
}

test('preferences: archive old chats after a chosen number of days', async ({
  page,
  person: _person,
}, testInfo) => {
  await page.goto(`/preferences`);
  const section = page.getByRole('region', { name: 'Archive old chats' });
  await expect(section).toBeVisible();
  const days = section.getByLabel('Archive chats after (days)');
  await expect(days).toHaveValue('');
  await shot(page, testInfo, 'chat-archive-01-default');

  // A window saves, and a reload reads it back from the server.
  await days.fill('30');
  await section.getByRole('button', { name: 'Save' }).click();
  await expect(section.getByText('Saved.')).toBeVisible();
  await page.reload();
  await expect(section.getByLabel('Archive chats after (days)')).toHaveValue('30');
  await shot(page, testInfo, 'chat-archive-02-saved');

  // Phone width: the field and its note still fit and stay usable.
  await page.setViewportSize(MOBILE_VIEWPORT);
  await page.reload();
  await expect(section.getByLabel('Archive chats after (days)')).toBeVisible();
  await shot(page, testInfo, 'chat-archive-04-mobile');
});
