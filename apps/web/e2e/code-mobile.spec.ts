/**
 * The code project's newer pieces at phone width, each driven and
 * pictured: the project page's header with Download and its dialog;
 * Add files from the title bar's "More", its picked list and live table;
 * the Uploads dialog from the indicator; the Code tab's tree with a
 * row's menu; and the composer's `@` completions over the box. Nothing
 * may scroll sideways. A resized Chromium viewport, not a device
 * project (AGENTS.md); the desktop paths are code-uploads.spec.ts and
 * code-downloads.spec.ts.
 */

import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Page, TestInfo } from '@playwright/test';
import { test, expect } from './fixtures';
import { removeModel } from './support/stub-model';
import { setUpCode, stageCodeProject } from './support/code-host';

const MOBILE_VIEWPORT = { width: 390, height: 844 };

// The stand-in model is staged by an operator.
test.use({ roles: ['renkei-user', 'renkei-operator'] });

async function shot(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  await page.screenshot({
    path: path.join(
      import.meta.dirname,
      '..',
      'test-results',
      'screens',
      testInfo.project.name,
      name
    ),
    fullPage: false,
  });
}

async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => ({
    scroll: document.documentElement.scrollWidth,
    client: document.documentElement.clientWidth,
  }));
  expect(overflow.scroll).toBeLessThanOrEqual(overflow.client);
}

test('a phone: Download, Add files, the indicator, the tree menu and @ completions', async ({
  page,
  request,
  person: _person,
}, testInfo) => {
  test.setTimeout(240_000);
  await page.setViewportSize(MOBILE_VIEWPORT);
  const tag = `${testInfo.project.name}-${randomUUID().slice(0, 6)}`;
  const modelId = await setUpCode(page, request, tag);
  const projectName = `Phone project (${tag})`;
  const chatTitle = `Phone chat (${tag})`;
  const { projectId, chatIds } = await stageCodeProject(page.request, {
    name: projectName,
    repository: 'acme/billing-service',
    branch: 'main',
    chats: [chatTitle],
    clone: true,
    llmModelId: modelId,
  });
  const main = page.getByRole('main');

  try {
    // ── The project page and its Download dialog ──
    await page.goto(`/code/${projectId}`);
    await expect(page.getByRole('heading', { level: 1, name: projectName })).toBeVisible({
      timeout: 30_000,
    });
    await expect(main.getByRole('heading', { level: 2, name: 'Environment' })).toBeVisible();
    await expectNoHorizontalOverflow(page);
    await shot(page, testInfo, 'phone-code-project.png');
    await main.getByRole('button', { name: 'More', exact: true }).click();
    await shot(page, testInfo, 'phone-code-project-menu.png');
    await main.getByRole('menuitem', { name: 'Download offline copy' }).click();
    const downloadDialog = page.getByRole('dialog', { name: 'Download an offline copy' });
    await expect(downloadDialog.getByRole('link', { name: 'Download zip' })).toBeVisible({
      timeout: 30_000,
    });
    await expectNoHorizontalOverflow(page);
    await shot(page, testInfo, 'phone-code-download.png');
    await downloadDialog.getByRole('button', { name: 'Done' }).click();

    // ── The chat: Add files lives in "More" on a phone ──
    await page.goto(`/chat/${chatIds[0]}`);
    await expect(page.getByRole('heading', { name: chatTitle })).toBeVisible({ timeout: 30_000 });
    await main.getByRole('button', { name: 'More', exact: true }).click();
    await shot(page, testInfo, 'phone-code-chat-more.png');
    await main.getByRole('menuitem', { name: 'Add files' }).click();
    const dialog = page.getByRole('dialog', { name: 'Add files' });
    await dialog.getByLabel('Folder (optional)').fill('docs');
    await dialog.locator('input[type="file"]').setInputFiles(
      Array.from({ length: 8 }, (_, index) => ({
        name: `page-${index + 1}.md`,
        mimeType: 'text/markdown',
        buffer: index === 2 ? Buffer.alloc(0) : Buffer.from(`# Page ${index + 1}\n`),
      }))
    );
    await expect(dialog.getByRole('list', { name: 'Files to add' }).getByRole('listitem')).toHaveCount(8);
    // The buttons stay on screen under the list.
    const addButton = dialog.getByRole('button', { name: 'Add to repository (8)' });
    await expect(addButton).toBeInViewport();
    await expectNoHorizontalOverflow(page);
    await shot(page, testInfo, 'phone-code-add-files-picked.png');

    // The one held back keeps the batch on the indicator afterwards.
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route('**/files?path=docs%2Fpage-8.md', async (route) => {
      await held;
      await route.continue();
    });
    await addButton.click();
    const table = dialog.getByTestId('upload-table');
    const rowOf = (name: string) => table.getByRole('listitem').filter({ hasText: name });
    await expect(rowOf('docs/page-1.md')).toContainText('Added');
    await expect(rowOf('docs/page-3.md')).toContainText('Failed');
    await expect(rowOf('docs/page-8.md')).toContainText('%');
    await expect(dialog.getByRole('button', { name: 'Done' })).toBeInViewport();
    await expectNoHorizontalOverflow(page);
    await shot(page, testInfo, 'phone-code-add-files-table.png');
    await dialog.getByRole('button', { name: 'Done' }).click();

    // ── The indicator in the phone's title bar, and its dialog ──
    const indicator = main.getByTestId('upload-indicator');
    // The count alone on a phone; the words are its name.
    await expect(indicator).toHaveText(/^\d\/8$/);
    await expect(indicator).toHaveAccessibleName(/Uploading \d of 8/);
    await expectNoHorizontalOverflow(page);
    await shot(page, testInfo, 'phone-code-upload-indicator.png');
    await indicator.click();
    const uploads = page.getByRole('dialog', { name: 'Uploads' });
    await expect(uploads.getByRole('button', { name: 'Stop' })).toBeVisible();
    await expectNoHorizontalOverflow(page);
    await shot(page, testInfo, 'phone-code-uploads-dialog.png');
    release();
    await expect(uploads.getByText('7 of 8 uploaded · 1 failed')).toBeVisible();
    await uploads.getByRole('button', { name: 'Dismiss' }).click();
    await expect(uploads).toHaveCount(0);
    await page.unroute('**/files?path=docs%2Fpage-8.md');

    // ── The Code tab: the tree with the new folder, a row's menu ──
    await main.getByRole('tablist', { name: 'Chat or code' }).getByRole('tab', { name: /Code/ }).click();
    const tree = main.getByRole('tree', { name: 'Files' });
    await tree.getByRole('button', { name: 'docs', exact: true }).click();
    await expect(tree.getByRole('button', { name: /^page-8\.md/ })).toBeVisible();
    await tree.getByRole('button', { name: 'More for docs' }).click();
    const menu = page.getByRole('menu', { name: 'More for docs' });
    await expect(menu.getByRole('menuitem', { name: 'Download as zip' })).toBeVisible();
    await expect(menu).toHaveCSS('opacity', '1');
    await expectNoHorizontalOverflow(page);
    await shot(page, testInfo, 'phone-code-tree-menu.png');
    await page.keyboard.press('Escape');
    await expect(menu).toHaveCount(0);

    // ── The composer's completions over the box ──
    await main.getByRole('tablist', { name: 'Chat or code' }).getByRole('tab', { name: /Chat/ }).click();
    const message = main.getByRole('textbox', { name: 'Message' });
    await message.click();
    await message.pressSequentially('Check @pag');
    const listbox = page.getByRole('listbox', { name: 'Files matching' });
    await expect(listbox.getByRole('option')).toHaveCount(7);
    await expect(listbox).toHaveAttribute('data-placement', 'above');
    await expectNoHorizontalOverflow(page);
    await shot(page, testInfo, 'phone-code-completions.png');
    await message.press('Enter');
    await expect(message).toHaveValue('Check @docs/page-1.md ');
  } finally {
    await removeModel(page.request, modelId);
  }
});
