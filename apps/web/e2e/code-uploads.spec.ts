/**
 * Getting files into a code project's checkout, and moving them about,
 * in a browser:
 *
 * - Add files (the chat's title-bar button): three files into a folder of
 *   the checkout, sent for real — the dialog's table answering Added per
 *   row and Failed for the empty one the route refuses, the tree beside
 *   the chat showing the new folder without a reload, and the title
 *   bar's indicator keeping the failed batch until it is dismissed.
 * - A file dropped from the desktop on a folder row lands in that
 *   folder; a row dragged onto another folder moves there; dragged onto
 *   the tree's own box, to the root.
 * - `@` in the composer completes a path: the list opens above the box
 *   with the typed text marked in each path, Enter takes the row.
 * - A row's "⋯" menu, portalled out of the scrolling rail, is drawn on a
 *   surface of its own.
 *
 * The rules moved out: the dialog's destinations, paths, button words and
 * the batch it sends are app/(app)/code/_components/add-files-modal.model.test.ts;
 * each row's state, retry and stop, a clean batch clearing itself, the
 * table's summary and Failed filter, and every state of the indicator
 * (uploading, failed, uploaded) are components/uploads/upload-queue.model.test.ts;
 * the empty-file refusal is app/api/code/projects/[projectId]/files/route.test.ts;
 * where a drop or a move lands is repo-tree.model.test.ts.
 *
 * Real routes and the real (stubbed) sandbox worker throughout —
 * sandbox-stub.mjs's upload/ls/mv/find verbs carry the same overlay a
 * real checkout would. Staged the way people make it: the person's
 * code project through the Code routes after connecting Bitbucket
 * (e2e/support/code-host.ts), a first turn cloning it. The phone pass
 * is a resized viewport at the end (AGENTS.md).
 */

import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Locator, Page, TestInfo } from '@playwright/test';
import { test, expect } from './fixtures';
import { removeModel } from './support/stub-model';
import { setUpCode, stageCodeProject } from './support/code-host';

const MOBILE_VIEWPORT = { width: 390, height: 844 };

// The stand-in model is staged by an operator.
test.use({ roles: ['renkei-user', 'renkei-operator'] });

interface Ids {
  projectId: string;
  chatId: string;
  projectName: string;
  chatTitle: string;
  modelId: string;
}

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

/** A drop of files from outside the page, as the browser would deliver it. */
async function dropFiles(target: Locator, files: { name: string; text: string }[]): Promise<void> {
  const transfer = await target.evaluateHandle((_, list) => {
    const transfer = new DataTransfer();
    for (const file of list) {
      transfer.items.add(new File([file.text], file.name, { type: 'text/plain' }));
    }
    return transfer;
  }, files);
  await target.dispatchEvent('drop', { dataTransfer: transfer });
}

test.describe('code uploads and the tree', () => {
  let ids: Ids;
  test.beforeEach(async ({ page, request, person: _person }, testInfo) => {
    test.setTimeout(240_000);
    const tag = `${testInfo.project.name}-${randomUUID().slice(0, 6)}`;
    const modelId = await setUpCode(page, request, tag);
    const projectName = `Uploads project (${tag})`;
    const chatTitle = `Uploads chat (${tag})`;
    const { projectId, chatIds } = await stageCodeProject(page.request, {
      name: projectName,
      repository: 'acme/billing-service',
      branch: 'main',
      chats: [chatTitle],
      clone: true,
      llmModelId: modelId,
    });
    ids = { projectId, chatId: chatIds[0], projectName, chatTitle, modelId };
  });
  test.afterEach(async ({ page }) => {
    await removeModel(page.request, ids.modelId);
  });

  test('Add files: the live table, the tree refreshing, the indicator', async ({
    page,
  }, testInfo) => {
    const main = page.getByRole('main');
    await page.goto(`/chat/${ids.chatId}`);
    await expect(page.getByRole('heading', { name: ids.chatTitle })).toBeVisible({
      timeout: 30_000,
    });
    const tree = main.getByRole('tree', { name: 'Files' });
    await expect(tree.getByText('package.json')).toBeVisible({ timeout: 30_000 });

    // Beside a wide code pane the chat's column is narrow, and the title
    // bar folds Add files into "More"; on a wider column it is a button.
    const addFiles = async () => {
      const button = main.getByRole('button', { name: 'Add files' });
      if (await button.isVisible()) await button.click();
      else {
        await main.getByRole('button', { name: 'More', exact: true }).click();
        await main.getByRole('menuitem', { name: 'Add files' }).click();
      }
    };

    // ── Into the checkout: a folder, three files — one of them empty, which
    //    the route refuses — then the table ──
    await addFiles();
    const dialog = page.getByRole('dialog', { name: 'Add files' });
    await dialog.getByLabel('Folder (optional)').fill('docs');
    await dialog.locator('input[type="file"]').setInputFiles([
      { name: 'guide.md', mimeType: 'text/markdown', buffer: Buffer.from('# Guide\n') },
      { name: 'empty.md', mimeType: 'text/markdown', buffer: Buffer.alloc(0) },
      { name: 'notes.md', mimeType: 'text/markdown', buffer: Buffer.from('# Notes\n') },
    ]);
    // The list scrolls on its own; the buttons stay put under it.
    await expect(dialog.getByRole('button', { name: 'Add to repository (3)' })).toBeVisible();
    await shot(page, testInfo, 'code-add-files-picked.png');
    await dialog.getByRole('button', { name: 'Add to repository (3)' }).click();

    const table = dialog.getByTestId('upload-table');
    const rowOf = (name: string) => table.getByRole('listitem').filter({ hasText: name });
    await expect(rowOf('docs/guide.md')).toContainText('Added');
    await expect(rowOf('docs/notes.md')).toContainText('Added');
    await expect(rowOf('docs/empty.md')).toContainText('Failed');
    await expect(rowOf('docs/empty.md')).toContainText('The file is empty.');
    await shot(page, testInfo, 'code-add-files-table.png');
    await dialog.getByRole('button', { name: 'Done' }).click();
    await expect(dialog).toHaveCount(0);

    // ── The tree already has the folder: no reload ──
    const docsRow = tree.getByRole('button', { name: 'docs', exact: true });
    await expect(docsRow).toBeVisible();
    await docsRow.click();
    await expect(tree.getByRole('button', { name: /^guide\.md/ })).toBeVisible();
    await expect(tree.getByRole('button', { name: /^notes\.md/ })).toBeVisible();
    await expect(tree.getByRole('button', { name: /^empty\.md/ })).toHaveCount(0);
    await shot(page, testInfo, 'code-add-files-tree-refreshed.png');

    // ── The title bar's indicator still carries the first batch: one of
    //    its files failed, so it stays until dismissed (a batch with
    //    nothing failed clears itself). Its dialog lists every batch ──
    const indicator = main.getByTestId('upload-indicator');
    // Beside a wide pane the chat's title bar is compact: the pill shows the
    // count alone and keeps the words as its name.
    await expect(indicator).toHaveAccessibleName(/1 upload failed/);
    await indicator.click();
    const uploads = page.getByRole('dialog', { name: 'Uploads' });
    await expect(uploads.getByText('docs/empty.md')).toBeVisible();
    await shot(page, testInfo, 'code-uploads-dialog.png');
    const dismiss = uploads.getByRole('button', { name: 'Dismiss' });
    while ((await dismiss.count()) > 0) await dismiss.first().click();
    // The last batch gone, the indicator goes — and the dialog is its.
    await expect(uploads).toHaveCount(0);
    await expect(indicator).toHaveCount(0);
  });

  test('drops on the tree, moves inside it, @ completions, the row menu', async ({
    page,
  }, testInfo) => {
    const main = page.getByRole('main');
    await page.goto(`/chat/${ids.chatId}`);
    await expect(page.getByRole('heading', { name: ids.chatTitle })).toBeVisible({
      timeout: 30_000,
    });
    const tree = main.getByRole('tree', { name: 'Files' });
    await expect(tree.getByText('package.json')).toBeVisible({ timeout: 30_000 });

    // ── A file from the desktop, dropped on the src folder, lands in it ──
    const srcRow = tree.getByRole('button', { name: 'src', exact: true }).locator('xpath=..');
    await dropFiles(srcRow, [{ name: 'dropped.txt', text: 'hello' }]);
    await expect(tree.getByRole('button', { name: /^dropped\.txt/ })).toBeVisible();
    await expect(tree.getByRole('button', { name: 'src', exact: true })).toHaveAttribute(
      'aria-expanded',
      'true'
    );
    // On the tree's own box: the root.
    const box = tree.locator('xpath=..');
    await dropFiles(box, [{ name: 'at-root.txt', text: 'top' }]);
    await expect(tree.getByRole('button', { name: /^at-root\.txt/ })).toBeVisible();
    await shot(page, testInfo, 'code-tree-dropped.png');

    // ── A row dragged onto a folder moves into it; onto the box, to the root ──
    const readmeRow = tree.getByRole('button', { name: /^README\.md/ }).locator('xpath=..');
    await readmeRow.dragTo(srcRow);
    // Moved, not yet committed: the file is at its new path, and its old
    // place keeps a struck-through ghost tagged D until a commit, as a
    // delete does (the row's title is the bare path; a ghost's says more).
    await expect(tree.locator('button[title="src/README.md"]')).toBeVisible();
    await expect(tree.getByRole('button', { name: /^README\.md/ })).toHaveCount(2);
    await expect(tree.getByTitle(/^README\.md — deleted/)).toBeVisible();
    const billingRow = tree.getByRole('button', { name: /^billing\.ts/ }).locator('xpath=..');
    // Let go in the empty space under the last row: the box's own target.
    const boxSize = await box.boundingBox();
    await billingRow.dragTo(box, {
      targetPosition: { x: 20, y: Math.max(1, (boxSize?.height ?? 40) - 6) },
    });
    await expect(tree.locator('button[title="billing.ts"]')).toBeVisible();
    await shot(page, testInfo, 'code-tree-moved.png');

    // ── @ completes a path, the list above the box, the match marked ──
    const message = main.getByRole('textbox', { name: 'Message' });
    await message.click();
    await message.pressSequentially('Look at @bill');
    const listbox = page.getByRole('listbox', { name: 'Files matching' });
    await expect(listbox).toBeVisible();
    await expect(listbox).toHaveAttribute('data-placement', 'above');
    const option = listbox.getByRole('option', { name: 'billing.ts' });
    await expect(option).toBeVisible();
    await expect(option.locator('mark')).toHaveText('bill');
    await expect(listbox.getByRole('option')).toHaveCount(1);
    await shot(page, testInfo, 'code-composer-completions.png');
    await message.press('Enter');
    await expect(listbox).toHaveCount(0);
    // billing.ts was moved to the root above, so that is its path now.
    await expect(message).toHaveValue('Look at @billing.ts ');
    // Narrowing: more typing, fewer rows; Escape puts it away.
    await message.pressSequentially('and @src/');
    await expect(listbox.getByRole('option')).toHaveCount(3);
    await message.pressSequentially('ind');
    await expect(listbox.getByRole('option')).toHaveCount(1);
    await expect(listbox.getByRole('option')).toContainText('src/index.ts');
    await message.press('Escape');
    await expect(listbox).toHaveCount(0);
    await message.fill('');

    // ── The row menu is drawn on its own surface, outside the rail ──
    await tree.getByRole('button', { name: 'More for package.json' }).click();
    const menu = page.getByRole('menu', { name: 'More for package.json' });
    await expect(menu).toBeVisible();
    await expect(menu).toHaveCSS('opacity', '1');
    await expect(menu).not.toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
    await expect(menu.getByRole('menuitem', { name: 'Rename' })).toBeVisible();
    await shot(page, testInfo, 'code-tree-row-menu.png');
    await page.keyboard.press('Escape');
    await expect(menu).toHaveCount(0);

    // ── A phone: the Code tab, the same tree, a drop still lands ──
    await page.setViewportSize(MOBILE_VIEWPORT);
    await main
      .getByRole('tablist', { name: 'Chat or code' })
      .getByRole('tab', { name: /Code/ })
      .click();
    await expect(tree.getByRole('button', { name: /^at-root\.txt/ })).toBeVisible();
    await dropFiles(box, [{ name: 'phone.txt', text: 'phone' }]);
    await expect(tree.getByRole('button', { name: /^phone\.txt/ })).toBeVisible();
    await shot(page, testInfo, 'code-tree-phone.png');
  });
});
