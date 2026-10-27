/**
 * The "Archive old chats" preference on the preferences page, end to end in
 * a browser: the default (never), saving a window, the refusal of a window
 * longer than the organization keeps chats, and clearing it back to never.
 *
 * The refusal is the part worth watching in a browser: the field stops an
 * over-long number before it leaves the page, and the server refuses the
 * same thing on its own, so both are asserted. The sweep that archives
 * chats runs in the worker, not here; this spec covers what a person sets.
 *
 * What is stored is read back through GET /api/preferences, the route the
 * page itself reads. The organization's chat retention is shared by every
 * spec in a run, so it is read from the org settings route rather than
 * assumed (the reader is an operator for that).
 */

import path from 'node:path';
import type { APIRequestContext, Page, TestInfo } from '@playwright/test';
import { test, expect } from './fixtures';

const RESULTS = path.join(import.meta.dirname, '..', '..', 'test-results');
const MOBILE_VIEWPORT = { width: 390, height: 844 };

test.use({ roles: ['renkei-user', 'renkei-operator'] });

/** The organization's chat retention in days, as the server reads it (0 = keep everything). */
async function orgRetentionDays(request: APIRequestContext): Promise<number> {
  const response = await request.get('/api/admin/org-settings');
  expect(response.ok(), await response.text()).toBe(true);
  const body: unknown = await response.json();
  const settings =
    typeof body === 'object' && body !== null && 'settings' in body ? body.settings : body;
  const days =
    typeof settings === 'object' && settings !== null && 'chatRetentionDays' in settings
      ? settings.chatRetentionDays
      : undefined;
  return typeof days === 'number' ? days : 365;
}

async function storedArchiveDays(request: APIRequestContext): Promise<unknown> {
  const response = await request.get('/api/preferences');
  expect(response.ok()).toBe(true);
  const body: { chatArchive?: { afterDays?: unknown } | null } = await response.json();
  return body.chatArchive?.afterDays ?? null;
}

async function shot(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  await page.screenshot({
    path: path.join(RESULTS, 'screens', testInfo.project.name, `${name}.png`),
    fullPage: true,
  });
}

test('preferences: archive old chats after a chosen number of days, never longer than the org keeps them', async ({
  page,
  person: _person,
}, testInfo) => {
  const retention = await orgRetentionDays(page.request);

  await page.goto(`/preferences`);
  const section = page.getByRole('region', { name: 'Archive old chats' });
  await expect(section).toBeVisible();

  // The default: never. An empty field, and nothing to save yet.
  const days = section.getByLabel('Archive chats after (days)');
  await expect(days).toHaveValue('');
  await expect(days).toHaveAttribute('placeholder', 'Never');
  await expect(section.getByRole('button', { name: 'Save' })).toBeDisabled();
  await shot(page, testInfo, 'chat-archive-01-default');

  // A window the org allows saves, survives a reload, and is what is stored.
  await days.fill('30');
  await section.getByRole('button', { name: 'Save' }).click();
  await expect(section.getByText('Saved.')).toBeVisible();
  await page.reload();
  await expect(section.getByLabel('Archive chats after (days)')).toHaveValue('30');
  expect(await storedArchiveDays(page.request)).toBe(30);
  await shot(page, testInfo, 'chat-archive-02-saved');

  // Longer than the organization keeps chats: refused in the field, and the
  // server refuses it too, so a stale page cannot save it around the check.
  const tooLong = retention > 0 ? retention + 1 : 3_651;
  if (retention > 0) {
    await section.getByLabel('Archive chats after (days)').fill(String(tooLong));
    await section.getByRole('button', { name: 'Save' }).click();
    await expect(section.getByText(`Enter ${retention} days or fewer.`)).toBeVisible();
    await shot(page, testInfo, 'chat-archive-03-refused');
  }
  const refused = await page.request.put('/api/preferences', {
    data: { chatArchive: { afterDays: tooLong } },
  });
  expect(refused.status()).toBe(400);
  expect(await storedArchiveDays(page.request)).toBe(30);

  // Clearing the field goes back to never.
  await section.getByLabel('Archive chats after (days)').fill('');
  await section.getByRole('button', { name: 'Save' }).click();
  await expect(section.getByText('Saved.')).toBeVisible();
  expect(await storedArchiveDays(page.request)).toBeNull();

  // Phone width: the field and its note still fit and stay usable.
  await page.setViewportSize(MOBILE_VIEWPORT);
  await page.reload();
  await expect(section.getByLabel('Archive chats after (days)')).toBeVisible();
  await shot(page, testInfo, 'chat-archive-04-mobile');
});
