/**
 * Getting files into a code project's checkout, and moving them about:
 *
 * - Add files (the chat's title-bar button) with its two destinations —
 *   the checkout, where the tree beside the chat shows the new folder
 *   and files the moment they land, without a reload; and the project's
 *   artifacts — its file list scrolling on its own under pinned buttons,
 *   and, once Add is pressed, the same files as a live table: Added per
 *   row, a failed row with why (an empty file is refused), and Failed
 *   narrowing the rows to it. The sends run in the app's upload queue:
 *   closing the dialog mid-upload leaves the title bar's indicator
 *   counting until the last file is answered.
 * - A file dropped from the desktop on a folder row lands in that
 *   folder; a row dragged onto another folder moves there; dragged onto
 *   the tree's own box, to the root.
 * - `@` in the composer completes a path: the list opens above the box
 *   with the typed text marked in each path, Enter takes the row.
 * - A row's "⋯" menu, portalled out of the scrolling rail, is drawn on a
 *   surface of its own.
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
async function dropFiles(
  target: Locator,
  files: { name: string; text: string }[]
): Promise<void> {
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

  test('Add files: destinations, the live table, the tree refreshing, the indicator', async ({
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
    await expect(dialog.getByRole('radio', { name: /repository’s checkout/ })).toBeChecked();
    await dialog.getByLabel('Folder (optional)').fill('docs');
    await dialog.locator('input[type="file"]').setInputFiles([
      { name: 'guide.md', mimeType: 'text/markdown', buffer: Buffer.from('# Guide\n') },
      { name: 'empty.md', mimeType: 'text/markdown', buffer: Buffer.alloc(0) },
      { name: 'notes.md', mimeType: 'text/markdown', buffer: Buffer.from('# Notes\n') },
    ]);
    const toAdd = dialog.getByRole('list', { name: 'Files to add' });
    await expect(toAdd.getByRole('listitem')).toHaveCount(3);
    await expect(toAdd).toContainText('docs/guide.md');
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
    await expect(table.getByRole('status')).toHaveText('2 of 3 uploaded · 1 failed');
    // No report in the footer: the rows are the report.
    await expect(dialog.getByText(/Added to the checkout/)).toHaveCount(0);
    await shot(page, testInfo, 'code-add-files-table.png');
    // Failed narrows the rows to the one that failed.
    await dialog.getByRole('button', { name: 'Failed (1)' }).click();
    await expect(table.getByRole('listitem')).toHaveCount(1);
    await expect(table.getByRole('listitem')).toContainText('docs/empty.md');
    await dialog.getByRole('button', { name: 'All' }).click();
    await expect(table.getByRole('listitem')).toHaveCount(3);
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

    // ── Into the project's artifacts instead ──
    await addFiles();
    await dialog.getByRole('radio', { name: /project’s artifacts/ }).check();
    await expect(dialog.getByLabel('Folder (optional)')).toHaveCount(0);
    await dialog.locator('input[type="file"]').setInputFiles({
      name: 'kept-note.md',
      mimeType: 'text/markdown',
      buffer: Buffer.from('# Kept\n'),
    });
    const artifactUpload = page.waitForResponse(
      (response) =>
        response.url().includes('/api/chat/attachments?') &&
        response.url().includes(`projectId=${ids.projectId}`) &&
        response.request().method() === 'PUT'
    );
    await dialog.getByRole('button', { name: 'Add to artifacts' }).click();
    expect((await artifactUpload).ok()).toBe(true);
    await expect(rowOf('kept-note.md → artifacts')).toContainText('Added');
    await dialog.getByRole('button', { name: 'Done' }).click();
    const artifacts = await page.request.get(`/api/chat/projects/${ids.projectId}/artifacts`);
    expect(artifacts.ok()).toBe(true);
    expect(JSON.stringify(await artifacts.json())).toContain('kept-note.md');
    // Not in the checkout.
    await expect(tree.getByRole('button', { name: /^kept-note\.md/ })).toHaveCount(0);

    // ── The title bar's indicator still carries the first batch: one of
    //    its files failed, so it stays until dismissed (a batch with
    //    nothing failed clears itself). Its dialog lists every batch ──
    const indicator = main.getByTestId('upload-indicator');
    await expect(indicator).toContainText('1 upload failed');
    await indicator.click();
    const uploads = page.getByRole('dialog', { name: 'Uploads' });
    await expect(uploads.getByText('docs/empty.md')).toBeVisible();
    await shot(page, testInfo, 'code-uploads-dialog.png');
    const dismiss = uploads.getByRole('button', { name: 'Dismiss' });
    while ((await dismiss.count()) > 0) await dismiss.first().click();
    // The last batch gone, the indicator goes — and the dialog is its.
    await expect(uploads).toHaveCount(0);
    await expect(indicator).toHaveCount(0);

    // ── A send that takes its time outlives the dialog: the indicator
    //    counts it until it is answered ──
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route('**/files?path=slow.txt', async (route) => {
      await held;
      await route.continue();
    });
    await addFiles();
    await dialog.locator('input[type="file"]').setInputFiles({
      name: 'slow.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('later'),
    });
    await dialog.getByRole('button', { name: 'Add to repository' }).click();
    await expect(dialog.getByText('Closing this keeps the upload going')).toBeVisible();
    await dialog.getByRole('button', { name: 'Done' }).click();
    await expect(indicator).toContainText('Uploading 1 of 1');
    await shot(page, testInfo, 'code-upload-indicator.png');
    // Its dialog shows the same table, with Stop while it runs.
    await indicator.click();
    await expect(uploads.getByText('slow.txt')).toBeVisible();
    await expect(uploads.getByRole('button', { name: 'Stop' })).toBeVisible();
    await uploads.getByRole('button', { name: 'Done' }).click();
    release();
    await expect(indicator).toContainText('Uploaded 1');
    await expect(tree.getByRole('button', { name: /^slow\.txt/ })).toBeVisible();
    // Done with nothing failed, the indicator clears itself.
    await expect(indicator).toHaveCount(0, { timeout: 10_000 });
    await page.unroute('**/files?path=slow.txt');
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
    await main.getByRole('tablist', { name: 'Chat or code' }).getByRole('tab', { name: /Code/ }).click();
    await expect(tree.getByRole('button', { name: /^at-root\.txt/ })).toBeVisible();
    await dropFiles(box, [{ name: 'phone.txt', text: 'phone' }]);
    await expect(tree.getByRole('button', { name: /^phone\.txt/ })).toBeVisible();
    await shot(page, testInfo, 'code-tree-phone.png');
  });
});
