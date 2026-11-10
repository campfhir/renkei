/**
 * The code pane's tree in a browser: a gitignored entry (node_modules,
 * seeded by the stub) drawn dimmed, one New file created through the
 * dialog and showing in the tree, and a tracked file deleted through its
 * row's "⋯" menu staying in the tree as a struck-through "ghost" row
 * tagged D, which opens its diff when clicked. desktop-dark walks it at
 * a phone's width, through the Code tab. Real routes and the real
 * (stubbed) sandbox worker throughout.
 *
 * The rules moved out: what the New file / Rename dialog sends or refuses
 * (".." refused before anything leaves, a trailing "/" and nested paths
 * sent as typed), the row menu's items, the dimming of everything inside
 * an ignored folder, which ghosts a folder shows and where a move lands
 * are app/(app)/code/_components/repo-tree.model.test.ts; that a trailing
 * "/" makes a folder, a nested path its parents, and a taken name is
 * refused are app/api/code/projects/[projectId]/files/route.test.ts.
 *
 * The project and chat are the test's own person's, made through the Code
 * routes after connecting Bitbucket (e2e/support/code-host.ts); a first
 * turn in the chat clones the repository and gives it its worktree.
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

test.describe('code pane file management', () => {
  let ids: Ids;
  test.beforeEach(async ({ page, request, person: _person }, testInfo) => {
    test.setTimeout(180_000);
    const tag = `${testInfo.project.name}-${randomUUID().slice(0, 6)}`;
    const modelId = await setUpCode(page, request, tag);
    const projectName = `File management project (${tag})`;
    const chatTitle = `File management chat (${tag})`;
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

  test('new file, delete — a deleted file ghosts in as D, node_modules stays dimmed', async ({
    page,
  }, testInfo) => {
    // The phone width the old `mobile` project gave, as a resized viewport on one project.
    const mobile = testInfo.project.name === 'desktop-dark';
    if (mobile) await page.setViewportSize(MOBILE_VIEWPORT);
    const main = page.getByRole('main');

    await page.goto(`/chat/${ids.chatId}`);
    await expect(page.getByRole('heading', { name: ids.chatTitle })).toBeVisible({
      timeout: 30_000,
    });

    if (mobile) {
      const tabs = main.getByRole('tablist', { name: 'Chat or code' });
      await tabs.getByRole('tab', { name: /Code/ }).click();
    }
    const tree = main.getByRole('tree', { name: 'Files' });
    // First hit on the tree/files/discard routes in this spec: dev-mode's
    // on-demand compile can outrun the default assertion timeout.
    await expect(tree.getByText('package.json')).toBeVisible({ timeout: 30_000 });

    // ── A gitignored entry stays in the tree, dimmed rather than hidden ──
    const nodeModulesRow = tree.getByRole('button', { name: 'node_modules', exact: true });
    await expect(nodeModulesRow).toBeVisible();
    // The dimming class sits on the row's own wrapping div, the button's
    // direct parent (its sibling is the per-row "⋯" menu).
    const nodeModulesWrapper = nodeModulesRow.locator('xpath=..');
    await expect(nodeModulesWrapper).toHaveCSS('opacity', '0.5');
    await shot(page, testInfo, 'code-tree-ignored-dimmed.png');

    // ── New file at the root ──
    await main.getByRole('button', { name: 'New file', exact: true }).click();
    const newFileDialog = page.getByRole('dialog', { name: 'New file' });
    await newFileDialog.getByLabel('File name').fill('notes.md');
    await shot(page, testInfo, 'code-tree-new-file-dialog.png');
    await newFileDialog.getByRole('button', { name: 'Create' }).click();
    await expect(newFileDialog).toHaveCount(0);
    // (a file row's own name is followed by its size — "notes.md 0 B" —
    // so an exact match on the bare name never hits; anchoring at the
    // start is what distinguishes the row from its own "More for" button)
    await expect(tree.getByRole('button', { name: /^notes\.md/ })).toBeVisible();
    await shot(page, testInfo, 'code-tree-new-file-created.png');

    // ── Deleting a tracked file leaves a struck-through "D" ghost row in
    //    its place — the working tree's changes are marks in the tree,
    //    not a separate list ──
    await tree.getByRole('button', { name: 'More for README.md' }).click();
    page.once('dialog', (dialog) => void dialog.accept());
    await page.getByRole('menu').getByRole('menuitem', { name: 'Delete' }).click();
    // The live row and its ghost both key off README.md's name (and the
    // ghost is a button too, once clickable), so wait for the (now
    // stale) live listing's own row — named with its size, not the
    // ghost's "D" tag — to clear the tree before looking for the ghost
    // that replaces it: the two refresh independently (the tree's own
    // reload vs. the working-tree marks) and can briefly overlap.
    await expect(tree.getByRole('button', { name: /^README\.md 1 KB$/ })).toHaveCount(0, {
      timeout: 10_000,
    });
    const ghost = tree.getByText('README.md', { exact: true });
    // The two listings settle into the one ghost row.
    await expect(ghost).toHaveCount(1, { timeout: 10_000 });
    await expect(ghost).toBeVisible();
    await expect(ghost).toHaveCSS('text-decoration-line', 'line-through');
    await expect(tree.getByText('D', { exact: true })).toBeVisible();
    await shot(page, testInfo, 'code-tree-deleted-ghost.png');

    // ── A ghost row has nothing left to open in the editor — clicking it
    //    opens its diff instead ──
    await ghost.click();
    await expect(page.getByRole('dialog', { name: 'Changes to README.md' })).toBeVisible();
  });
});
