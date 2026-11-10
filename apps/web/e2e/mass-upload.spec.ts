/**
 * The chat composer's attachment staging, in a browser: chips, the counter
 * chip, the mass-upload warning and the file list as they look (screenshots,
 * on a desktop and a phone, fitting the phone's width), and one real pass —
 * files chosen, the warning confirmed, every file reaching the upload route
 * and the scanned ones the OCR route, the list opened and closed with
 * Escape. The upload and OCR routes are answered at the browser edge
 * (page.route) — there is no blob store or OCR vendor in e2e.
 *
 * The rules are composer.model.test.ts's now: the threshold (at it nothing
 * asks; past it, counting what is staged and uploading), Cancel uploading
 * nothing, two chips vs one counter from the third file, the warning's
 * words, the progress and OCR counts, OCR batches of twelve, each file's
 * text status, removing from the list. The manifest and OCR server logic
 * are covered by the unit tests beside attachments.ts.
 *
 * The chat is the test's own person's (the browser suite's `person`
 * fixture), made through the chat's own route. Mobile is a resized
 * Chromium viewport, not the `mobile` project (AGENTS.md).
 */

import { createHash } from 'node:crypto';
import path from 'node:path';
import type { Page, TestInfo } from '@playwright/test';
import { test, expect } from './fixtures';
import { createChat } from './support/code-host';

const RESULTS = path.join(import.meta.dirname, '..', 'test-results');
const MOBILE_VIEWPORT = { width: 390, height: 844 };

function uuidFrom(seed: string): string {
  const hex = createHash('sha256').update(seed).digest('hex');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    `4${hex.slice(13, 16)}`,
    `8${hex.slice(17, 20)}`,
    hex.slice(20, 32),
  ].join('-');
}

async function openChat(page: Page) {
  const chatId = await createChat(page.request, { title: 'Applicant review' });
  const uploaded: string[] = [];
  const ocrRequests: string[][] = [];
  await page.route('**/chat/attachments?*', async (route) => {
    const filename = new URL(route.request().url()).searchParams.get('filename') ?? 'file';
    uploaded.push(filename);
    const scanned = filename.startsWith('scan-');
    await route.fulfill({
      status: 201,
      contentType: 'application/json',
      body: JSON.stringify({
        attachment: {
          id: uuidFrom(`att:${filename}`),
          filename,
          contentType: 'application/pdf',
          sizeBytes: 100,
          extractStatus: scanned ? 'needs_ocr' : 'done',
        },
      }),
    });
  });
  await page.route('**/chat/attachments/ocr', async (route) => {
    const ids: string[] = route.request().postDataJSON().attachmentIds;
    ocrRequests.push(ids);
    await new Promise((resolve) => setTimeout(resolve, 400));
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ results: ids.map((id) => ({ id, extractStatus: 'done' })) }),
    });
  });
  await page.goto(`/chat/${chatId}`);
  await expect(page.getByRole('textbox', { name: 'Message' })).toBeVisible();
  return { uploaded, ocrRequests };
}

function pdfs(count: number, scanned = 0, prefix = 'applicant') {
  return Array.from({ length: count }, (_, index) => ({
    name: `${index < scanned ? 'scan-' : `${prefix}-`}${index + 1}.pdf`,
    mimeType: 'application/pdf',
    buffer: Buffer.from(`%PDF-1.4 fake ${prefix} ${index}`),
  }));
}

async function shot(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  await page.screenshot({
    path: path.join(RESULTS, 'screens', testInfo.project.name, `${name}.png`),
    fullPage: true,
  });
}

test('composer: files staged as chips, then a mass upload confirmed, uploaded and OCR’d', async ({
  page,
  person: _person,
}, testInfo) => {
  const { uploaded, ocrRequests } = await openChat(page);
  const input = page.getByRole('main').locator('input[type="file"]');
  const warning = page.getByRole('alertdialog', { name: 'Large upload' });

  // Two chips, then the counter chip: how they look.
  await input.setInputFiles(pdfs(2, 0, 'first'));
  await expect(page.getByRole('link', { name: /\.pdf$/ })).toHaveCount(2);
  await shot(page, testInfo, 'mass-upload-two-chips');
  await input.setInputFiles(pdfs(1, 0, 'third'));
  const counter = page.getByRole('button', { name: 'Show all 3 attached files' });
  await expect(counter).toBeVisible();
  await shot(page, testInfo, 'mass-upload-counter-chip');

  // The one real pass: past the threshold, confirmed, every file up and the scans read.
  await input.setInputFiles(pdfs(14, 3));
  await expect(warning).toBeVisible();
  await shot(page, testInfo, 'mass-upload-warning');
  await warning.getByRole('button', { name: 'Upload 14 files' }).click();
  await expect(warning).toHaveCount(0);
  await expect(page.getByText('Reading scans')).toBeVisible();
  await shot(page, testInfo, 'mass-upload-ocr-running');
  await expect(page.getByText('Reading scans')).toHaveCount(0);
  expect(uploaded).toHaveLength(17);
  expect(ocrRequests.flat()).toHaveLength(3);

  const all = page.getByRole('button', { name: 'Show all 17 attached files' });
  await expect(all).toContainText('17 attachments');
  await shot(page, testInfo, 'mass-upload-folded');
  await all.click();
  const list = page.getByRole('dialog', { name: 'Attached files' });
  await expect(list.getByRole('link')).toHaveCount(17);
  await shot(page, testInfo, 'mass-upload-file-list');
  await page.keyboard.press('Escape');
  await expect(list).toHaveCount(0);

  // Phone width: the counter, the warning and the list fit without side-scroll.
  await page.setViewportSize(MOBILE_VIEWPORT);
  await shot(page, testInfo, 'mass-upload-counter-chip-mobile');
  await input.setInputFiles(pdfs(11, 0, 'more'));
  await expect(warning).toBeVisible();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth
  );
  expect(overflow).toBeLessThanOrEqual(0);
  await shot(page, testInfo, 'mass-upload-warning-mobile');
  await warning.getByRole('button', { name: 'Cancel' }).click();
  await all.click();
  await expect(list).toBeVisible();
  const box = await list.locator('> div').boundingBox();
  expect(box?.width ?? 999).toBeLessThanOrEqual(MOBILE_VIEWPORT.width);
  await shot(page, testInfo, 'mass-upload-file-list-mobile');
});
