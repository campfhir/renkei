/**
 * A code project's Artifacts card, a page at a time: a project can hold
 * more files than fit on its page, so the card lists ten and pages through
 * the rest — the range and page shown, Previous and Next held at the
 * ends, a detach on the last page staying on what is left, and the pager
 * gone once everything fits on one page. Then the same card at phone
 * width.
 *
 * Staged the way people make it: the person's code project through the
 * Code routes after connecting Bitbucket (e2e/support/code-host.ts), and
 * each file uploaded straight to the project, as the card's Upload does.
 */

import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { APIRequestContext, Page, TestInfo } from '@playwright/test';
import { test, expect } from './fixtures';
import { removeModel } from './support/stub-model';
import { createCodeProject, setUpCode } from './support/code-host';

// The stand-in model is staged by an operator.
test.use({ roles: ['renkei-user', 'renkei-operator'] });

const FILES = 12;
const PAGE_SIZE = 10;

const nameOf = (n: number) => `notes-${String(n).padStart(2, '0')}.md`;

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

/**
 * The project's page. The KeyGuard may still be refreshing the page the
 * connect flow left open (it re-seals, then refreshes server data), which
 * aborts a navigation sent in the middle of it; the second one lands.
 */
async function openProject(page: Page, projectId: string): Promise<void> {
  await page.goto(`/code/${projectId}`).catch(async (error: unknown) => {
    if (!String(error).includes('ERR_ABORTED')) throw error;
    await page.goto(`/code/${projectId}`);
  });
}

/** One file uploaded to the project, attached on demand as the card's Upload attaches it. */
async function uploadTo(request: APIRequestContext, projectId: string, n: number): Promise<void> {
  const query = new URLSearchParams({
    filename: nameOf(n),
    contentType: 'text/markdown',
    projectId,
  });
  const response = await request.put(`/api/chat/attachments?${query.toString()}`, {
    headers: { 'content-type': 'text/markdown' },
    data: Buffer.from(`# Notes ${n}\n\nWhat the team agreed in meeting ${n}.\n`),
  });
  expect(response.status(), await response.text()).toBe(201);
}

test.describe('a code project’s Artifacts card', () => {
  let projectId: string;
  let modelId: string;

  test.beforeEach(async ({ page, request, person: _person }, testInfo) => {
    test.setTimeout(120_000);
    const tag = `${testInfo.project.name}-${randomUUID().slice(0, 6)}`;
    modelId = await setUpCode(page, request, tag);
    projectId = await createCodeProject(page.request, {
      name: `Paged artifacts (${tag})`,
      repository: 'acme/billing-service',
      branch: 'main',
    });
    // Oldest first: the card lists files in the order they were attached.
    for (let n = 1; n <= FILES; n += 1) await uploadTo(page.request, projectId, n);
  });

  test.afterEach(async ({ page }) => {
    await removeModel(page.request, modelId);
  });

  test('pages through the files, ten at a time', async ({ page }, testInfo) => {
    await openProject(page, projectId);
    const card = page.getByRole('main').getByRole('region', { name: 'Artifacts' });
    const rows = card.locator('li[data-artifact]');
    const pager = card.getByRole('navigation', { name: 'Artifact pages' });

    await expect(card.getByText(`${FILES} attached`)).toBeVisible({ timeout: 30_000 });
    await expect(rows).toHaveCount(PAGE_SIZE);
    await expect(rows.first()).toContainText(nameOf(1));
    await expect(rows.last()).toContainText(nameOf(PAGE_SIZE));
    await expect(card.getByText(nameOf(11))).toBeHidden();
    await expect(pager.getByText(`1–${PAGE_SIZE} of ${FILES}`)).toBeVisible();
    await expect(pager.getByText('Page 1 of 2')).toBeVisible();
    await expect(pager.getByRole('button', { name: 'Previous page' })).toBeDisabled();
    await shot(page, testInfo, 'code-project-artifacts-01-page-1.png');

    await pager.getByRole('button', { name: 'Next page' }).click();
    await expect(rows).toHaveCount(FILES - PAGE_SIZE);
    await expect(rows.first()).toContainText(nameOf(11));
    await expect(card.getByText(nameOf(1), { exact: true })).toBeHidden();
    await expect(pager.getByText(`11–${FILES} of ${FILES}`)).toBeVisible();
    await expect(pager.getByText('Page 2 of 2')).toBeVisible();
    await expect(pager.getByRole('button', { name: 'Next page' })).toBeDisabled();
    await shot(page, testInfo, 'code-project-artifacts-02-page-2.png');

    // A detach on the last page stays there with what is left.
    const detached12 = page.waitForResponse(
      (response) =>
        response.request().method() === 'DELETE' &&
        response.url().includes(`/api/chat/projects/${projectId}/artifacts/`)
    );
    await card.getByRole('button', { name: `Remove ${nameOf(12)} from` }).click();
    const response12 = await detached12;
    expect(response12.status(), await response12.text()).toBe(200);
    await expect(card.getByText(`${FILES - 1} attached`)).toBeVisible();
    await expect(rows).toHaveCount(1);
    await expect(pager.getByText(`11–11 of ${FILES - 1}`)).toBeVisible();

    // Down to one page's worth: the pager goes, and every file is listed.
    const detached11 = page.waitForResponse(
      (response) =>
        response.request().method() === 'DELETE' &&
        response.url().includes(`/api/chat/projects/${projectId}/artifacts/`)
    );
    await card.getByRole('button', { name: `Remove ${nameOf(11)} from` }).click();
    const response11 = await detached11;
    expect(response11.status(), await response11.text()).toBe(200);
    await expect(card.getByText(`${PAGE_SIZE} attached`)).toBeVisible();
    await expect(pager).toBeHidden();
    await expect(rows).toHaveCount(PAGE_SIZE);
    await expect(rows.first()).toContainText(nameOf(1));

    // Back after a reload, the server's word agrees.
    await page.reload();
    await expect(card.getByText(`${PAGE_SIZE} attached`)).toBeVisible({ timeout: 30_000 });
    await expect(rows).toHaveCount(PAGE_SIZE);
    await expect(pager).toBeHidden();
  });

  test('at phone width the pager fits and still pages', async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openProject(page, projectId);
    const card = page.getByRole('main').getByRole('region', { name: 'Artifacts' });
    const rows = card.locator('li[data-artifact]');
    const pager = card.getByRole('navigation', { name: 'Artifact pages' });

    await expect(card.getByText(`${FILES} attached`)).toBeVisible({ timeout: 30_000 });
    await pager.scrollIntoViewIfNeeded();
    await expect(pager.getByRole('button', { name: 'Next page' })).toBeInViewport();
    const box = await pager.boundingBox();
    expect(box && box.x + box.width).toBeLessThanOrEqual(390);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth
    );
    expect(overflow).toBeLessThanOrEqual(0);
    await shot(page, testInfo, 'code-project-artifacts-03-phone.png');

    await pager.getByRole('button', { name: 'Next page' }).click();
    await expect(rows).toHaveCount(FILES - PAGE_SIZE);
    await expect(pager.getByText('Page 2 of 2')).toBeVisible();
  });
});
