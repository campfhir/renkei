/**
 * Copies of a code project to keep: the whole checkout as a zip from the
 * project page's Download button (beside Share) — ignored files such as
 * node_modules in it, since an offline copy is meant to work without a
 * network — a folder as a zip and a file as itself from a tree row's
 * "⋯" menu in the chat. Real routes and the real (stubbed) sandbox
 * worker: sandbox-stub.mjs's `download` verb zips the same fixture and
 * overlay the tree lists. The project is the test's own person's, made
 * through the Code routes after connecting Bitbucket
 * (e2e/support/code-host.ts), its first chat's turn cloning it.
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import JSZip from 'jszip';
import type { Download, Page, TestInfo } from '@playwright/test';
import { test, expect } from './fixtures';
import { removeModel } from './support/stub-model';
import { setUpCode, stageCodeProject } from './support/code-host';

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

async function zipEntries(download: Download): Promise<string[]> {
  const file = await download.path();
  const zip = await JSZip.loadAsync(await readFile(file));
  return Object.keys(zip.files).filter((name) => !zip.files[name]!.dir).sort();
}

test('a project, a folder and a file download as a zip, a zip and itself', async ({
  page,
  request,
  person: _person,
}, testInfo) => {
  test.setTimeout(240_000);
  const tag = `${testInfo.project.name}-${randomUUID().slice(0, 6)}`;
  const modelId = await setUpCode(page, request, tag);
  const projectName = `Downloads project (${tag})`;
  const chatTitle = `Downloads chat (${tag})`;
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
    // ── The whole checkout, from the project page ──
    await page.goto(`/code/${projectId}`);
    await expect(page.getByRole('heading', { level: 1, name: projectName })).toBeVisible({
      timeout: 30_000,
    });
    await main.getByRole('button', { name: 'Download project' }).click();
    const dialog = page.getByRole('dialog', { name: 'Download an offline copy' });
    await expect(dialog.getByText(/node_modules/)).toBeVisible();
    const link = dialog.getByRole('link', { name: 'Download zip' });
    // The dialog looks at the checkout first (one request; dev-mode's
    // on-demand compile can be slow on a first hit).
    await expect(link).toBeVisible({ timeout: 30_000 });
    await expect(dialog).toContainText('billing-service.zip');
    await shot(page, testInfo, 'code-download-project.png');
    const projectDownload = page.waitForEvent('download');
    await link.click();
    const whole = await projectDownload;
    expect(whole.suggestedFilename()).toBe('billing-service.zip');
    const entries = await zipEntries(whole);
    expect(entries).toEqual(
      expect.arrayContaining([
        'README.md',
        'package.json',
        'src/billing.ts',
        'src/index.ts',
        'node_modules/.keep',
        'node_modules/left-pad/index.js',
      ])
    );
    await dialog.getByRole('button', { name: 'Done' }).click();

    // ── A folder and a file, from the tree's row menu in the chat ──
    await page.goto(`/chat/${chatIds[0]}`);
    const tree = main.getByRole('tree', { name: 'Files' });
    await expect(tree.getByText('package.json')).toBeVisible({ timeout: 30_000 });
    await tree.getByRole('button', { name: 'More for src' }).click();
    const srcMenu = page.getByRole('menu', { name: 'More for src' });
    await expect(srcMenu.getByRole('menuitem', { name: 'Download as zip' })).toBeVisible();
    await shot(page, testInfo, 'code-tree-download-menu.png');
    const folderDownload = page.waitForEvent('download');
    await srcMenu.getByRole('menuitem', { name: 'Download as zip' }).click();
    const folder = await folderDownload;
    expect(folder.suggestedFilename()).toBe('src.zip');
    expect(await zipEntries(folder)).toEqual(['src/billing.ts', 'src/index.ts']);

    await tree.getByRole('button', { name: 'More for package.json' }).click();
    const fileDownload = page.waitForEvent('download');
    await page
      .getByRole('menu', { name: 'More for package.json' })
      .getByRole('menuitem', { name: 'Download', exact: true })
      .click();
    const file = await fileDownload;
    expect(file.suggestedFilename()).toBe('package.json');
    const text = await readFile((await file.path())!, 'utf8');
    expect(text).toContain('"name": "billing-service"');

    // ── Nothing cloned, nothing to copy: a fresh project says so ──
    const { projectId: bare } = await stageCodeProject(page.request, {
      name: `Bare project (${tag})`,
      repository: 'acme/billing-service',
      branch: 'main',
      llmModelId: modelId,
    });
    await page.goto(`/code/${bare}`);
    await main.getByRole('button', { name: 'Download project' }).click();
    await expect(dialog.getByTestId('download-not-cloned')).toBeVisible();
    await expect(dialog.getByRole('link', { name: 'Download zip' })).toHaveCount(0);
  } finally {
    await removeModel(page.request, modelId);
  }
});
