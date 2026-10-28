/**
 * The top-bar search reaches down to the setting, connector or organization
 * setting itself: a result opens its page scrolled to the element that holds
 * it, and that element is in view. An artifact is found by its digest: the
 * file is written by a chat turn whose (stand-in) model hands it over with
 * a summary and keywords (chat_write_file), as a chat's own model does.
 */

import { randomUUID } from 'node:crypto';
import { test, expect } from './fixtures';
import { addStubModel, toolStep, removeModel, scripted } from '../support/stub-model';
import { askAndWait, createChat } from '../support/code-host';

// Organization settings are found by an operator; the stub model is staged by one.
test.use({ roles: ['renkei-user', 'renkei-operator'] });

async function search(page: import('@playwright/test').Page, text: string) {
  const box = page.getByRole('searchbox', { name: 'Search Renkei' });
  await box.fill(text);
  return page.getByRole('listbox', { name: 'Results' });
}

test('dark mode lands on the appearance section, scrolled into view', async ({
  page,
  person: _person,
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
  person: _person,
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

test('OnBase is found by its own name', async ({ page, person: _person }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-light', 'A desktop check.');
  await page.goto('/agents');
  const results = await search(page, 'onbase');
  await results.getByRole('option', { name: /OnBase/ }).click();
  await expect(page).toHaveURL(/\/connectors\?find=onbase#connector-hyland$/);
});

test('an operator is sent straight to an organization setting', async ({
  page,
  person: _person,
}, testInfo) => {
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
  person: _person,
}, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-light', 'A desktop check.');
  const tag = randomUUID().slice(0, 6);
  const summary =
    'Month-end ledger reconciliation: matches bank statements to posted journal entries.';
  const modelId = await addStubModel(page.request, `deep-search-${tag}`);
  try {
    // The keyword is only in the digest, not in the file name.
    const write = {
      filename: `deep-search-close-workbook-${tag}.csv`,
      content: 'account,amount\n4000,120.50\n',
      summary,
      keywords: ['reconciliation', 'general ledger'],
    };
    const chatId = await createChat(page.request, { llmModelId: modelId });
    await askAndWait(page.request, chatId, {
      text: scripted('Write up the close workbook.', [toolStep('chat_write_file', write)]),
      llmModelId: modelId,
    });
    await page.goto('/agents');
    const results = await search(page, 'reconciliation');
    const option = results.getByRole('option', { name: /deep-search-close-workbook/ });
    await expect(option).toBeVisible();
    await expect(option).toContainText('Month-end ledger reconciliation');
  } finally {
    await removeModel(page.request, modelId);
  }
});
