/**
 * Switching a code chat's worktree to another branch — the chat's title
 * bar, through "Switch branch" in its overflow menu, which opens
 * branch-switcher.tsx's `BranchPickerModal`. There is no other picker:
 * the title bar has no reliable room for an inline one (a wide viewport
 * still narrows this column when the code pane sits beside it), so the
 * modal is the one path at every width, and the project screen carries
 * no branch picker, or mention of a branch, at all — it is about the
 * repository as a whole. Every chat in a project has its own worktree
 * and so its own switcher.
 *
 * The project and its two chats are the test's own person's, made through
 * the Code routes after connecting Bitbucket (e2e/support/code-host.ts);
 * a first turn in each chat clones the repository and gives the chat its
 * worktree, as it does for a person. The branch routes themselves are
 * mocked at the browser edge, as before.
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
  activeChatId: string;
  otherChatId: string;
  projectName: string;
  activeChatTitle: string;
  otherChatTitle: string;
  modelId: string;
}

/** The project, both chats, each with its own worktree off a ready checkout. */
async function stage(
  page: Page,
  request: import('@playwright/test').APIRequestContext,
  testInfo: TestInfo
): Promise<Ids> {
  const tag = `${testInfo.project.name}-${randomUUID().slice(0, 6)}`;
  const modelId = await setUpCode(page, request, tag);
  const names = {
    projectName: `Branch switcher project (${tag})`,
    activeChatTitle: `Active chat (${tag})`,
    otherChatTitle: `Other chat (${tag})`,
  };
  const { projectId, chatIds } = await stageCodeProject(page.request, {
    name: names.projectName,
    repository: 'acme/billing-service',
    branch: 'main',
    chats: [names.activeChatTitle, names.otherChatTitle],
    clone: true,
    llmModelId: modelId,
  });
  return { ...names, projectId, activeChatId: chatIds[0], otherChatId: chatIds[1], modelId };
}

/** The branch route, mocked: `feature/x` is offered and switching to it succeeds. */
async function mockBranchRoute(page: Page, projectId: string): Promise<void> {
  await page.route(`**/api/code/projects/${projectId}/chats/*/branch`, async (route) => {
    if (route.request().method() === 'GET') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          branches: [
            { name: 'main', headSha: 'aaaaaaaaaaaa' },
            { name: 'feature/x', headSha: 'bbbbbbbbbbbb' },
          ],
        }),
      });
      return;
    }
    const body: unknown = route.request().postDataJSON();
    const branch =
      body && typeof body === 'object' && 'branch' in body && typeof body.branch === 'string'
        ? body.branch
        : 'feature/x';
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ branch }),
    });
  });
}

/**
 * The branch route, mocked so the first switch attempt is refused for a
 * dirty tree (branch/route.ts's real 409 'dirty') and …/discard clears
 * it — the same shapes those routes actually return, exercised here
 * against the branch-switcher.tsx UI they drive (the modal, and
 * "Discard changes and switch to <branch>"), same as `mockBranchRoute`
 * mocks the ordinary switch it's built on.
 */
async function mockDirtyThenCleanBranchRoute(page: Page, projectId: string): Promise<void> {
  let attempted = 0;
  await page.route(`**/api/code/projects/${projectId}/chats/*/branch`, async (route) => {
    if (route.request().method() === 'GET') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          branches: [
            { name: 'main', headSha: 'aaaaaaaaaaaa' },
            { name: 'feature/x', headSha: 'bbbbbbbbbbbb' },
          ],
        }),
      });
      return;
    }
    attempted += 1;
    if (attempted === 1) {
      await route.fulfill({
        status: 409,
        contentType: 'application/json',
        body: JSON.stringify({
          error:
            'There are uncommitted changes on the checkout. Commit or discard them before switching branches.',
          code: 'dirty',
        }),
      });
      return;
    }
    const body: unknown = route.request().postDataJSON();
    const branch =
      body && typeof body === 'object' && 'branch' in body && typeof body.branch === 'string'
        ? body.branch
        : 'feature/x';
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ branch }),
    });
  });
  await page.route(`**/api/code/projects/${projectId}/chats/*/discard`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ branch: 'main' }),
    });
  });
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

test.describe('branch switcher', () => {
  let ids: Ids;
  test.beforeEach(async ({ page, request, person: _person }, testInfo) => {
    test.setTimeout(180_000);
    ids = await stage(page, request, testInfo);
  });
  test.afterEach(async ({ page }) => {
    await removeModel(page.request, ids.modelId);
  });

  test('the project screen carries no branch mention; each chat switches its own worktree through its overflow menu', async ({
    page,
  }, testInfo) => {
    // The phone width the old `mobile` project gave, as a resized viewport on one project.
    const mobile = testInfo.project.name === 'desktop-dark';
    if (mobile) await page.setViewportSize(MOBILE_VIEWPORT);
    await mockBranchRoute(page, ids.projectId);
    const main = page.getByRole('main');

    // ── The project screen: about the repository as a whole, no branch
    //    picker or mention of one in the Repository card ──
    await page.goto(`/code/${ids.projectId}`);
    await expect(page.getByRole('heading', { level: 1, name: ids.projectName })).toBeVisible();
    const repository = main.locator('section', {
      has: page.getByRole('heading', { level: 2, name: 'Repository' }),
    });
    await expect(repository).toContainText('acme/billing-service');
    // The card's only control is the checkout-size request (size-request.tsx);
    // nothing on it picks or names a branch.
    await expect(
      repository.getByRole('button').filter({ hasNotText: 'Ask for more space' })
    ).toHaveCount(0);
    await expect(repository.getByText(/main|feature/)).toHaveCount(0);
    await shot(page, testInfo, 'branch-switcher-project-no-mention.png');

    // ── The active chat's title bar: a plain read-only label, and
    //    "Switch branch" in the overflow menu opens the picker as a
    //    modal — the only path, at any width ──
    await page.goto(`/chat/${ids.activeChatId}`);
    await expect(page.getByRole('heading', { name: ids.activeChatTitle })).toBeVisible();
    const chatBranch = main.locator('[data-testid="chat-branch"]');
    await expect(chatBranch).toBeVisible();
    await expect(chatBranch).toContainText('renkei/');
    await expect(chatBranch.getByRole('button')).toHaveCount(0);
    await main.getByRole('button', { name: 'More', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Switch branch' }).click();
    const branchModal = page.getByRole('dialog', { name: 'Switch branch' });
    await expect(branchModal.getByRole('option', { name: 'feature/x' })).toBeVisible();
    await shot(page, testInfo, 'branch-switcher-chat-modal.png');
    await branchModal.getByRole('option', { name: 'feature/x' }).click();
    await expect(branchModal).toHaveCount(0);
    await expect(chatBranch).toContainText('feature/x');
    await shot(page, testInfo, 'branch-switcher-chat-switched.png');

    // ── Another chat in the same project has its own worktree, so its own
    //    label and its own "Switch branch" entry ──
    await page.goto(`/chat/${ids.otherChatId}`);
    await expect(page.getByRole('heading', { name: ids.otherChatTitle })).toBeVisible();
    await expect(main.locator('[data-testid="chat-branch"]')).toBeVisible();
    await main.getByRole('button', { name: 'More', exact: true }).click();
    await expect(page.getByRole('menuitem', { name: 'Switch branch' })).toBeVisible();
    await shot(page, testInfo, 'branch-switcher-other-chat.png');
  });

  test('a dirty checkout is refused with a clear reason, and discarding lets the switch through', async ({
    page,
  }, testInfo) => {
    // The phone width the old `mobile` project gave, as a resized viewport on one project.
    const mobile = testInfo.project.name === 'desktop-dark';
    if (mobile) await page.setViewportSize(MOBILE_VIEWPORT);
    await mockDirtyThenCleanBranchRoute(page, ids.projectId);
    const main = page.getByRole('main');

    // ── Picking a branch on a dirty checkout: a modal names the problem,
    //    not an overlapping inline error, with a way through ──
    await page.goto(`/chat/${ids.activeChatId}`);
    await expect(page.getByRole('heading', { name: ids.activeChatTitle })).toBeVisible();
    const chatBranch = main.locator('[data-testid="chat-branch"]');
    await expect(chatBranch).toContainText('renkei/');
    await main.getByRole('button', { name: 'More', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Switch branch' }).click();
    const branchModal = page.getByRole('dialog', { name: 'Switch branch' });
    await branchModal.getByRole('option', { name: 'feature/x' }).click();
    const blocked = branchModal.getByRole('alert');
    await expect(blocked).toBeVisible();
    await expect(
      blocked.getByText(
        'There are uncommitted changes on the checkout. Commit or discard them before switching branches.'
      )
    ).toBeVisible();
    await expect(blocked.getByText(/anything not committed is lost/)).toBeVisible();
    const discard = blocked.getByRole('button', {
      name: 'Discard changes and switch to feature/x',
    });
    await expect(discard).toBeVisible();
    await shot(page, testInfo, 'branch-switcher-dirty-modal.png');

    // ── Discarding retries the same switch, which now goes through ──
    await discard.click();
    await expect(branchModal).toHaveCount(0);
    await expect(chatBranch).toContainText('feature/x');
    await shot(page, testInfo, 'branch-switcher-dirty-discarded.png');
  });
});
