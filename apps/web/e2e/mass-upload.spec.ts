/**
 * The chat composer's mass-upload path: a selection under the threshold
 * uploads straight away, one over it asks first ("Large upload"), Cancel
 * uploads nothing, and confirming uploads every file and then OCRs the
 * scanned ones. The upload and OCR routes are mocked at the browser edge
 * (page.route) — there is no blob store or OCR vendor in e2e — so this
 * asserts the composer's own behaviour: the warning, the progress and the
 * per-file statuses. The manifest and OCR server logic are covered by the
 * unit tests beside attachments.ts.
 *
 * Its own tenant per Playwright project (the llm-models.spec.ts pattern):
 * projects run concurrently against one dev database. Mobile is a resized
 * Chromium viewport, not the `mobile` project (AGENTS.md).
 */

import { createHash } from 'node:crypto';
import path from 'node:path';
import { test, expect, type Page, type TestInfo } from '@playwright/test';
import { Client } from 'pg';

const RESULTS = path.join(import.meta.dirname, '..', 'test-results');
const MOBILE_VIEWPORT = { width: 390, height: 844 };

test.use({
  launchOptions: {
    executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    args: ['--no-sandbox'],
  },
});

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

function fixtureFor(projectName: string) {
  return {
    sessionId: uuidFrom(`mass-upload-e2e-session:${projectName}`),
    chatId: uuidFrom(`mass-upload-e2e-chat:${projectName}`),
    slug: `e2e-mass-upload-${projectName}`,
    subject: `e2e-mass-upload-${projectName}@example.com`,
  };
}

async function seed(fixture: ReturnType<typeof fixtureFor>): Promise<void> {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    await client.query('DELETE FROM chats', [fixture.tenantId]);
    await client.query('DELETE FROM sessions', [fixture.tenantId]);
    await client.query('DELETE FROM identities', [fixture.tenantId]);
    await client.query('DELETE FROM tenants WHERE id = $1', [fixture.tenantId]);
    await client.query('INSERT INTO tenants (id, slug) VALUES ($1, $2)', [
      fixture.tenantId,
      fixture.slug,
    ]);
    await client.query(
      `INSERT INTO sessions (id, tenant_id, subject, roles, expires_at) VALUES ($1, $2, $3, $4, $5)`,
      [
        fixture.sessionId,
        fixture.tenantId,
        fixture.subject,
        ['renkei-user'],
        new Date(Date.now() + 24 * 3_600_000),
      ]
    );
    await client.query(
      `INSERT INTO identities (tenant_id, subject, email, display_name) VALUES ($1, $2, $3, $4)`,
      [fixture.tenantId, fixture.subject, fixture.subject, 'E2E Tester']
    );
    await client.query(
      `INSERT INTO user_preferences (tenant_id, subject, key, value)
       VALUES ($1, $2, 'coach_marks', '{"autoStart": false}'::jsonb)`,
      [fixture.tenantId, fixture.subject]
    );
    await client.query(
      `INSERT INTO chats (id, tenant_id, owner_subject, title, last_message_at)
       VALUES ($1, $2, $3, 'Applicant review', NOW())`,
      [fixture.chatId, fixture.tenantId, fixture.subject]
    );
  } finally {
    await client.end();
  }
}

async function openChat(page: Page, fixture: ReturnType<typeof fixtureFor>) {
  await page.context().addCookies([
    {
      name: `renkei_session`,
      value: fixture.sessionId,
      domain: '127.0.0.1',
      path: '/',
      httpOnly: true,
      secure: false,
      sameSite: 'Lax',
    },
  ]);
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
  await page.goto(`/chat/${fixture.chatId}`);
  await expect(page.getByRole('textbox', { name: 'Message' })).toBeVisible();
  return { uploaded, ocrRequests };
}

function pdfs(count: number, scanned = 0) {
  return Array.from({ length: count }, (_, index) => ({
    name: `${index < scanned ? 'scan-' : 'applicant-'}${index + 1}.pdf`,
    mimeType: 'application/pdf',
    buffer: Buffer.from(`%PDF-1.4 fake ${index}`),
  }));
}

async function shot(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  await page.screenshot({
    path: path.join(RESULTS, 'screens', testInfo.project.name, `${name}.png`),
    fullPage: true,
  });
}

test('composer: a mass upload warns first, then uploads and OCRs scans', async ({
  page,
}, testInfo) => {
  const fixture = fixtureFor(testInfo.project.name);
  await seed(fixture);
  const { uploaded } = await openChat(page, fixture);
  const input = page.locator('input[type="file"]');

  // At the threshold (10) nothing asks.
  await input.setInputFiles(pdfs(10));
  await expect(page.getByRole('alertdialog', { name: 'Large upload' })).toHaveCount(0);
  await expect.poll(() => uploaded.length).toBe(10);
  await expect(page.getByRole('button', { name: 'Show all 10 attached files' })).toContainText(
    '10 attachments'
  );
});

test('composer: cancelling the warning uploads nothing; confirming uploads all and OCRs scans', async ({
  page,
}, testInfo) => {
  const fixture = fixtureFor(`${testInfo.project.name}-b`);
  await seed(fixture);
  const { uploaded, ocrRequests } = await openChat(page, fixture);
  const input = page.locator('input[type="file"]');
  const warning = page.getByRole('alertdialog', { name: 'Large upload' });

  await input.setInputFiles(pdfs(14, 3));
  await expect(warning).toBeVisible();
  await expect(warning).toContainText('Add 14 files?');
  await expect(warning).toContainText('More than 10 files is a mass upload');
  await shot(page, testInfo, 'mass-upload-warning');

  await warning.getByRole('button', { name: 'Cancel' }).click();
  await expect(warning).toHaveCount(0);
  expect(uploaded).toHaveLength(0);

  await input.setInputFiles(pdfs(14, 3));
  await warning.getByRole('button', { name: 'Upload 14 files' }).click();
  await expect(warning).toHaveCount(0);
  await expect(page.getByText('Reading scans')).toBeVisible();
  await shot(page, testInfo, 'mass-upload-ocr-running');
  await expect(page.getByText('Reading scans')).toHaveCount(0);
  expect(uploaded).toHaveLength(14);
  expect(ocrRequests.flat()).toHaveLength(3);

  // 14 files are one "14 attachments" chip, not a wall of chips.
  await expect(page.getByRole('link', { name: /\.pdf$/ })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Show all 14 attached files' })).toContainText(
    '14 attachments'
  );
  await shot(page, testInfo, 'mass-upload-folded');
  await page.getByRole('button', { name: 'Show all 14 attached files' }).click();
  const list = page.getByRole('dialog', { name: 'Attached files' });
  await expect(list).toContainText('Attached files (14)');
  await expect(list.getByRole('link')).toHaveCount(14);
  await shot(page, testInfo, 'mass-upload-file-list');
  await list.getByRole('button', { name: 'Remove applicant-14.pdf' }).click();
  await expect(list).toContainText('Attached files (13)');
  await page.keyboard.press('Escape');
  await expect(list).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Show all 13 attached files' })).toContainText(
    '13 attachments'
  );

  // Mobile pass: the warning fits a phone viewport without side-scroll.
  await page.setViewportSize(MOBILE_VIEWPORT);
  await input.setInputFiles(pdfs(11));
  await expect(warning).toBeVisible();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth
  );
  expect(overflow).toBeLessThanOrEqual(0);
  await shot(page, testInfo, 'mass-upload-warning-mobile');
  await warning.getByRole('button', { name: 'Cancel' }).click();
  await page.getByRole('button', { name: 'Show all 13 attached files' }).click();
  await expect(list).toBeVisible();
  const box = await list.locator('> div').boundingBox();
  expect(box?.width ?? 999).toBeLessThanOrEqual(MOBILE_VIEWPORT.width);
  await shot(page, testInfo, 'mass-upload-file-list-mobile');
});

test('composer: 2 files stay as chips; 3 or more become one counter chip, on a phone too', async ({
  page,
}, testInfo) => {
  const fixture = fixtureFor(`${testInfo.project.name}-c`);
  await seed(fixture);
  await openChat(page, fixture);
  const input = page.locator('input[type="file"]');

  // Two files: each is its own chip, no counter.
  await input.setInputFiles(pdfs(2));
  await expect(page.getByRole('link', { name: /\.pdf$/ })).toHaveCount(2);
  await expect(page.getByRole('button', { name: /attached files/ })).toHaveCount(0);
  await shot(page, testInfo, 'mass-upload-two-chips');

  // The third file collapses everything into one counter chip, far under the
  // mass-upload threshold.
  await input.setInputFiles(pdfs(1).map((file) => ({ ...file, name: `third-${file.name}` })));
  await expect(page.getByRole('link', { name: /\.pdf$/ })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Show all 3 attached files' })).toContainText(
    '3 attachments'
  );
  await shot(page, testInfo, 'mass-upload-counter-chip');
  await page.setViewportSize(MOBILE_VIEWPORT);
  await shot(page, testInfo, 'mass-upload-counter-chip-mobile');

  // Past the mass-upload threshold it is still the one chip, with the count.
  await input.setInputFiles(pdfs(9).map((file) => ({ ...file, name: `more-${file.name}` })));
  await page.getByRole('button', { name: 'Upload 9 files' }).click();
  await expect(page.getByRole('button', { name: 'Show all 12 attached files' })).toContainText(
    '12 attachments'
  );
  await shot(page, testInfo, 'mass-upload-counter-chip-large-mobile');
});
