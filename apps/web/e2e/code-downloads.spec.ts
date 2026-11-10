/**
 * Copies of a code project to keep, in a browser: the project page's
 * Download button (beside Share) opens its dialog, and the zip link saves
 * a real download named for the repository; a tree row's "⋯" menu in the
 * chat offers a folder as a zip; a project not cloned yet says there is
 * nothing to copy. Real routes and the real (stubbed) sandbox worker. The
 * project is the test's own person's, made through the Code routes after
 * connecting Bitbucket (e2e/support/code-host.ts), its first chat's turn
 * cloning it.
 *
 * What is in a download — the whole checkout with node_modules, a folder
 * as a zip of only that folder, a file as its own bytes, each named for
 * the browser, a chat's worktree rather than the base clone — is
 * app/api/code/projects/[projectId]/archive/route.test.ts's.
 */

import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Page, TestInfo } from '@playwright/test';
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

test('a project downloads as a zip, and the tree offers a folder as one', async ({
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
    await main.getByRole('button', { name: 'More', exact: true }).click();
    await main.getByRole('menuitem', { name: 'Download offline copy' }).click();
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
    expect(await whole.failure()).toBeNull();
    await dialog.getByRole('button', { name: 'Done' }).click();

    // ── A folder, from the tree's row menu in the chat ──
    await page.goto(`/chat/${chatIds[0]}`);
    const tree = main.getByRole('tree', { name: 'Files' });
    await expect(tree.getByText('package.json')).toBeVisible({ timeout: 30_000 });
    await tree.getByRole('button', { name: 'More for src' }).click();
    const srcMenu = page.getByRole('menu', { name: 'More for src' });
    await expect(srcMenu.getByRole('menuitem', { name: 'Download as zip' })).toBeVisible();
    await shot(page, testInfo, 'code-tree-download-menu.png');

    // ── Nothing cloned, nothing to copy: a fresh project says so ──
    const { projectId: bare } = await stageCodeProject(page.request, {
      name: `Bare project (${tag})`,
      repository: 'acme/billing-service',
      branch: 'main',
      llmModelId: modelId,
    });
    await page.goto(`/code/${bare}`);
    await main.getByRole('button', { name: 'More', exact: true }).click();
    await main.getByRole('menuitem', { name: 'Download offline copy' }).click();
    await expect(dialog.getByTestId('download-not-cloned')).toBeVisible();
    await expect(dialog.getByRole('link', { name: 'Download zip' })).toHaveCount(0);
  } finally {
    await removeModel(page.request, modelId);
  }
});
