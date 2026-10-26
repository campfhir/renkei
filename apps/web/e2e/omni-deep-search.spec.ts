/**
 * The top-bar search reaches down to the setting, connector or organization
 * setting itself: a result opens its page scrolled to the element that holds
 * it, and that element is in view.
 */

import { randomUUID } from 'node:crypto';
import { test, expect } from './worker-env';
import { Client } from 'pg';
import { E2E_SUBJECT } from './seed';
test.use({
  launchOptions: {
    executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    args: ['--no-sandbox'],
  },
});

async function search(page: import('@playwright/test').Page, text: string) {
  const box = page.getByRole('searchbox', { name: 'Search Renkei' });
  await box.fill(text);
  return page.getByRole('listbox', { name: 'Results' });
}

test('dark mode lands on the appearance section, scrolled into view', async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-light', 'A desktop check.');
  await page.goto('/agents');
  const results = await search(page, 'dark mode');
  await results.getByRole('option', { name: /Dark mode and appearance/ }).click();
  await expect(page).toHaveURL(/\/preferences#appearance-heading$/);
  await expect(page.locator('#appearance-heading')).toBeInViewport();
});

test('a connector is found by a product inside it and opens its card or the catalog', async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-light', 'A desktop check.');
  await page.goto('/agents');
  const results = await search(page, 'sharepoint');
  const option = results.getByRole('option', { name: /Microsoft 365/ });
  await expect(option).toContainText('Connectors');
  await option.click();
  await expect(page).toHaveURL(/\/connectors\?find=sharepoint#connector-microsoft$/);
  // A connector already on the page is scrolled to; one that is not is
  // searched for in the catalog, so the person can add it there.
  const card = page.locator('#connector-microsoft');
  if (await card.count()) {
    await expect(card).toBeInViewport();
  } else {
    await expect(page.getByRole('textbox', { name: 'Search connectors' })).toHaveValue(
      'sharepoint'
    );
  }
});

test('OnBase is found by its own name', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-light', 'A desktop check.');
  await page.goto('/agents');
  const results = await search(page, 'onbase');
  await results.getByRole('option', { name: /OnBase/ }).click();
  await expect(page).toHaveURL(/\/connectors\?find=onbase#connector-hyland$/);
});

test('an operator is sent straight to an organization setting', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-light', 'A desktop check.');
  await page.goto('/agents');
  const results = await search(page, 'safety');
  const option = results.getByRole('option', { name: /Safety/ });
  await expect(option).toContainText('Organization settings');
  await option.click();
  await expect(page).toHaveURL(/\/admin\/settings#settings-safety$/);
  await expect(page.locator('#settings-safety')).toBeInViewport();
});

test('an artifact is found by a keyword in its summary, and the row shows the summary', async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-light', 'A desktop check.');
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  const id = randomUUID();
  const summary =
    'Month-end ledger reconciliation: matches bank statements to posted journal entries.';
  try {
    await client.query(
      "DELETE FROM artifacts WHERE owner_subject = $1 AND filename LIKE 'deep-search-%'",
      [E2E_SUBJECT]
    );
    // The keyword is only in the digest, not in the file name.
    await client.query(
      `INSERT INTO artifacts (id, owner_subject, chat_id, blob_key, filename, content_type, size_bytes,
         extract_status, origin, key_kind, summary, keywords, digest_status, search_vector)
       VALUES ($1, $2, NULL, $3, 'deep-search-close-workbook.xlsx',
         'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 10,
         'done', 'upload', 'artifact', $4, $5, 'done',
         setweight(to_tsvector('english', $6), 'A') || setweight(to_tsvector('english', $4), 'B'))`,
      [
        id,
        E2E_SUBJECT,
        `chat/e2e/${id}`,
        summary,
        ['reconciliation', 'general ledger'],
        'reconciliation general ledger',
      ]
    );
    await page.goto('/agents');
    const results = await search(page, 'reconciliation');
    const option = results.getByRole('option', { name: /deep-search-close-workbook/ });
    await expect(option).toBeVisible();
    await expect(option).toContainText('Month-end ledger reconciliation');
  } finally {
    await client.query(
      "DELETE FROM artifacts WHERE owner_subject = $1 AND filename LIKE 'deep-search-%'",
      [E2E_SUBJECT]
    );
    await client.end();
  }
});
