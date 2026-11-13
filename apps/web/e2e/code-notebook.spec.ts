/**
 * A notebook in the code pane, in a browser: `notebooks/revenue.ipynb`
 * (seeded by the stub with two cells' outputs committed) opens as a
 * notebook — its markdown rendered, its saved table drawn — rather than
 * as JSON; Run all sends the run to the (stubbed) sandbox worker, the
 * outputs it wrote into the checkout's file are drawn (the chart the
 * third cell had never drawn), and Source shows the file itself.
 * desktop-dark walks it at a phone's width, through the Code tab. Real
 * routes and the real (stubbed) sandbox worker throughout.
 *
 * The rules are elsewhere: when Run may be pressed, what a refused or
 * failed run leaves on screen and what a stop says are
 * app/(app)/code/_components/notebook-view.model.test.ts; how a notebook
 * file is read (outputs, the richest form, a file that is not one) is
 * lib/code/notebook.test.ts; what the run command does with a real
 * Python is lib/code/notebook-runner.test.ts; who may run and what the
 * route answers is app/api/code/projects/[projectId]/notebook/run/route.test.ts.
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

  test('a notebook opens as a notebook, runs on the sandbox, and shows its source', async ({
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
    // The chart cell has never been run: no figure yet.
    await expect(notebook.getByTestId('cell-image')).toHaveCount(0);
    await shot(page, testInfo, 'code-notebook-opened.png');

    // ── Run all: the sandbox runs it, the file's new outputs are drawn ──
    const ran = page.waitForResponse(
      (response) =>
        response.url().endsWith('/notebook/run') && response.request().method() === 'POST'
    );
    await notebook.getByRole('button', { name: 'Run all' }).click();
    expect((await ran).status()).toBe(200);
    await expect(notebook.getByTestId('notebook-run-status')).toContainText('Ran 3 cells');
    const chart = notebook.getByTestId('cell-image');
    await expect(chart).toBeVisible();
    await chart.scrollIntoViewIfNeeded();
    // Drawn, not a broken image.
    await expect
      .poll(() => chart.evaluate((image: HTMLImageElement) => image.naturalWidth))
      .toBeGreaterThan(0);
    await shot(page, testInfo, 'code-notebook-ran.png');

    // ── Source: the file as it is, in the pane's own editor ──
    await notebook.getByRole('button', { name: 'Source' }).click();
    await expect(notebook.getByText('"cells"').first()).toBeVisible({ timeout: 30_000 });
    await shot(page, testInfo, 'code-notebook-source.png');
  });
});
