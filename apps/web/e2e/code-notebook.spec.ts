/**
 * A notebook in the code pane, in a browser: `notebooks/revenue.ipynb`
 * (seeded by the stub with two cells' outputs committed) opens as a
 * notebook — its markdown rendered, its saved table drawn — rather than
 * as JSON; a code cell is added and typed in where it is and run with
 * Shift+Enter in the notebook's kernel on the (stubbed) sandbox worker,
 * its output drawn under it; Run all runs the rest (the chart the third
 * cell had never drawn); Packages installs through the same kernel; and
 * Source shows the file itself. desktop-dark walks it at a phone's
 * width, through the Code tab. Real routes and the real (stubbed)
 * sandbox worker throughout.
 *
 * The rules are elsewhere: when cells may be run, edited, added or
 * moved, the order they run in, and what a raised cell, a stop, a lost
 * kernel or a refused install leaves on screen are
 * app/(app)/code/_components/notebook-view.model.test.ts; how a notebook
 * file is read and changed is lib/code/notebook.test.ts; who may run and
 * what the route answers is
 * app/api/code/projects/[projectId]/notebook/kernel/route.test.ts; what
 * a real kernel does with a real Python is
 * apps/worker-sandbox/src/kernel-sessions.test.ts.
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

test.describe('code pane notebooks', () => {
  let ids: { chatId: string; chatTitle: string; modelId: string };
  test.beforeEach(async ({ page, request, person: _person }, testInfo) => {
    test.setTimeout(180_000);
    const tag = `${testInfo.project.name}-${randomUUID().slice(0, 6)}`;
    const modelId = await setUpCode(page, request, tag);
    const chatTitle = `Notebook chat (${tag})`;
    const { chatIds } = await stageCodeProject(page.request, {
      name: `Notebook project (${tag})`,
      repository: 'acme/billing-service',
      branch: 'main',
      chats: [chatTitle],
      clone: true,
      llmModelId: modelId,
    });
    ids = { chatId: chatIds[0], chatTitle, modelId };
  });
  test.afterEach(async ({ page }) => {
    await removeModel(page.request, ids.modelId);
  });

  test('a notebook opens as a notebook, is edited and run a cell at a time, and shows its source', async ({
    page,
  }, testInfo) => {
    const mobile = testInfo.project.name === 'desktop-dark';
    if (mobile) await page.setViewportSize(MOBILE_VIEWPORT);
    const main = page.getByRole('main');

    await page.goto(`/chat/${ids.chatId}`);
    await expect(page.getByRole('heading', { name: ids.chatTitle })).toBeVisible({
      timeout: 30_000,
    });
    if (mobile) {
      await main
        .getByRole('tablist', { name: 'Chat or code' })
        .getByRole('tab', { name: /Code/ })
        .click();
    }
    const tree = main.getByRole('tree', { name: 'Files' });
    await tree.getByRole('button', { name: 'notebooks', exact: true }).click({ timeout: 30_000 });
    await tree.getByRole('button', { name: /^revenue\.ipynb/ }).click();

    // ── The file is drawn as its cells, with the outputs it was committed with ──
    const notebook = main.getByTestId('notebook-view');
    await expect(notebook.getByRole('heading', { name: 'Monthly revenue' })).toBeVisible({
      timeout: 30_000,
    });
    await expect(notebook.getByText('Loaded 4 months')).toBeVisible();
    await expect(notebook.getByRole('cell', { name: '42987.25' })).toBeVisible();
    // The chart cell has never been run: no figure yet. Nothing has run: no kernel.
    await expect(notebook.getByTestId('cell-image')).toHaveCount(0);
    await expect(notebook.getByTestId('notebook-kernel')).toContainText('No kernel yet');
    await shot(page, testInfo, 'code-notebook-opened.png');

    // ── A text cell opens as text on a double click, and closes rendered ──
    await notebook.getByRole('heading', { name: 'Monthly revenue' }).dblclick();
    const prose = notebook.getByRole('textbox', { name: 'Text of text cell' });
    await expect(prose).toBeFocused();
    await prose.fill('# Monthly revenue, reviewed\n\nEdited where it is.');
    await shot(page, testInfo, 'code-notebook-text-editing.png');
    await prose.press('Shift+Enter');
    await expect(
      notebook.getByRole('heading', { name: 'Monthly revenue, reviewed' })
    ).toBeVisible();

    // ── A cell added and typed in where it is, run on its own with Shift+Enter ──
    await notebook.getByRole('button', { name: 'Add a code cell here' }).last().click();
    const added = notebook.getByRole('textbox', { name: 'Code of cell 4' });
    await expect(added).toBeFocused();
    await added.fill('print("Edited in place")');
    const ran = page.waitForResponse(
      (response) =>
        response.url().endsWith('/notebook/kernel') && response.request().method() === 'POST'
    );
    await added.press('Shift+Enter');
    expect((await ran).status()).toBe(200);
    await expect(notebook.getByText('Edited in place', { exact: true })).toBeVisible();
    // The kernel the run started stays: the toolbar names it.
    await expect(notebook.getByTestId('notebook-kernel')).toContainText('Python 3.11.2');
    // Only that cell ran: the chart cell above it is still undrawn.
    await expect(notebook.getByTestId('cell-image')).toHaveCount(0);
    await shot(page, testInfo, 'code-notebook-cell-run.png');

    // ── Run all: every cell in turn, the chart drawn at last ──
    await notebook.getByRole('button', { name: 'Run all' }).click();
    await expect(notebook.getByTestId('notebook-run-status')).toContainText('Ran 4 cells');
    const chart = notebook.getByTestId('cell-image');
    await expect(chart).toBeVisible();
    await chart.scrollIntoViewIfNeeded();
    // Drawn, not a broken image.
    await expect
      .poll(() => chart.evaluate((image: HTMLImageElement) => image.naturalWidth))
      .toBeGreaterThan(0);
    await shot(page, testInfo, 'code-notebook-ran.png');

    // ── Packages: an install through the same kernel ──
    await notebook.getByRole('button', { name: 'Packages' }).click();
    await notebook.getByRole('textbox', { name: 'Packages to install' }).fill('seaborn');
    await notebook.getByRole('button', { name: 'Install', exact: true }).click();
    await expect(notebook.getByTestId('notebook-install-log')).toContainText(
      'Successfully installed seaborn'
    );
    await shot(page, testInfo, 'code-notebook-packages.png');

    // ── Source: the file as it is, in the pane's own editor ──
    await notebook.getByRole('button', { name: 'Source' }).click();
    await expect(notebook.getByText('"cells"').first()).toBeVisible({ timeout: 30_000 });
    await shot(page, testInfo, 'code-notebook-source.png');
  });
});
