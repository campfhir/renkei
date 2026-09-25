/**
 * Switching a code project's checkout branch — the active chat's title
 * bar, through "Switch branch" in its overflow menu, which opens
 * branch-switcher.tsx's `BranchPickerModal`. There is no other picker:
 * the title bar has no reliable room for an inline one (a wide viewport
 * still narrows this column when the code pane sits beside it), so the
 * modal is the one path at every width, and the project screen carries
 * no branch picker, or mention of a branch, at all — it is about the
 * repository as a whole. A history chat keeps the plain read-only
 * label with no "Switch branch" entry, since it can no longer send
 * turns.
 *
 * Own tenant fixtures under the shared e2e/seed.ts tenant (AGENTS.md:
 * fine to share the tenant when nothing races on uniqueness or an
 * empty-state assertion), with project/chat ids distinct from
 * code.spec.ts's own so the two specs never collide running side by
 * side.
 */

import path from 'node:path';
import { test, expect, type Page, type TestInfo } from '@playwright/test';
import { Client } from 'pg';
import { E2E_SLUG, E2E_SUBJECT, E2E_TENANT_ID } from './seed';

const MOBILE_VIEWPORT = { width: 390, height: 844 };

test.use({
  browserName: 'chromium',
  launchOptions: {
    executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    args: ['--no-sandbox'],
  },
});

function idsFor(project: string) {
  const digit = { 'desktop-light': '1', 'desktop-dark': '2', mobile: '3' }[project] ?? '4';
  return {
    projectId: `77777777-7777-4777-8777-7777777777${digit}1`,
    activeChatId: `77777777-7777-4777-8777-7777777777${digit}2`,
    historyChatId: `77777777-7777-4777-8777-7777777777${digit}3`,
    projectName: `Branch switcher project (${digit})`,
    activeChatTitle: `Active chat (${digit})`,
    historyChatTitle: `History chat (${digit})`,
  };
}

async function db(): Promise<Client> {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  return client;
}

async function seedFixtures(ids: ReturnType<typeof idsFor>): Promise<void> {
  const client = await db();
  try {
    await client.query('DELETE FROM chats WHERE id = ANY($1)', [
      [ids.activeChatId, ids.historyChatId],
    ]);
    await client.query('DELETE FROM chat_projects WHERE id = $1', [ids.projectId]);
    await client.query(
      `INSERT INTO chat_projects
         (id, tenant_id, owner_subject, name, kind, repo_provider, repo_full_name, repo_branch)
       VALUES ($1, $2, $3, $4, 'code', 'atlassian-bitbucket', 'acme/billing-service', 'main')`,
      [ids.projectId, E2E_TENANT_ID, E2E_SUBJECT, ids.projectName]
    );
    await client.query(
      `INSERT INTO chats (id, tenant_id, owner_subject, project_id, title, last_message_at)
       VALUES ($1, $2, $3, $4, $5, NOW())`,
      [ids.activeChatId, E2E_TENANT_ID, E2E_SUBJECT, ids.projectId, ids.activeChatTitle]
    );
    await client.query(
      `INSERT INTO chats (id, tenant_id, owner_subject, project_id, title, last_message_at)
       VALUES ($1, $2, $3, $4, $5, NOW())`,
      [ids.historyChatId, E2E_TENANT_ID, E2E_SUBJECT, ids.projectId, ids.historyChatTitle]
    );
    await client.query('UPDATE chat_projects SET active_chat_id = $1 WHERE id = $2', [
      ids.activeChatId,
      ids.projectId,
    ]);
  } finally {
    await client.end();
  }
}

/**
 * A ready checkout, the way the first chat in a project would leave one —
 * cloned on the real sandbox-stub worker (project-view.ts reads a
 * project's workspace status live from the worker, not from a DB row),
 * then the project pointed at it. Mirrors code.spec.ts's own
 * seedCheckout.
 */
async function seedCheckout(ids: ReturnType<typeof idsFor>): Promise<void> {
  const worker = process.env.SANDBOX_WORKER_URL ?? 'http://127.0.0.1:8092';
  const headers = {
    authorization: `Bearer ${process.env.SANDBOX_WORKER_API_KEY ?? 'e2e-sandbox-key'}`,
    'content-type': 'application/json',
  };
  const target = { tenantId: E2E_TENANT_ID, subject: `code-project:${ids.projectId}` };
  const cloned = await fetch(`${worker}/v1/workspaces/clone`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      ...target,
      provider: 'atlassian-bitbucket',
      repoFullName: 'acme/billing-service',
      branch: 'main',
      cloneUrl: 'https://bitbucket.org/acme/billing-service.git',
      authHeader: 'Basic e2e',
    }),
  });
  const { workspace }: { workspace: { id: string } } = await cloned.json();
  for (let tries = 0; tries < 20; tries += 1) {
    const got = await fetch(`${worker}/v1/workspaces/get`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ ...target, id: workspace.id }),
    });
    const state: { workspace: { status: string } } = await got.json();
    if (state.workspace.status === 'ready') break;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  const client = await db();
  try {
    await client.query('UPDATE chat_projects SET workspace_id = $1 WHERE id = $2', [
      workspace.id,
      ids.projectId,
    ]);
  } finally {
    await client.end();
  }
}

async function cleanFixtures(ids: ReturnType<typeof idsFor>): Promise<void> {
  const client = await db();
  try {
    await client.query('DELETE FROM chats WHERE id = ANY($1)', [
      [ids.activeChatId, ids.historyChatId],
    ]);
    await client.query('DELETE FROM chat_projects WHERE id = $1', [ids.projectId]);
  } finally {
    await client.end();
  }
}

/** The branch route, mocked: `feature/x` is offered and switching to it succeeds. */
async function mockBranchRoute(page: Page, projectId: string): Promise<void> {
  await page.route(`**/api/tenant/**/code/projects/${projectId}/branch`, async (route) => {
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
  await page.route(`**/api/tenant/**/code/projects/${projectId}/branch`, async (route) => {
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
          error: 'There are uncommitted changes on the checkout. Commit or discard them before switching branches.',
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
  await page.route(`**/api/tenant/**/code/projects/${projectId}/discard`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ branch: 'main' }),
    });
  });
}

async function shot(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  await page.screenshot({
    path: path.join(import.meta.dirname, '..', 'test-results', 'screens', testInfo.project.name, name),
    fullPage: false,
  });
}

test.describe('branch switcher', () => {
  // eslint-disable-next-line no-empty-pattern
  test.beforeEach(async ({}, testInfo) => {
    const ids = idsFor(testInfo.project.name);
    await seedFixtures(ids);
    await seedCheckout(ids);
  });
  // eslint-disable-next-line no-empty-pattern
  test.afterEach(async ({}, testInfo) => {
    await cleanFixtures(idsFor(testInfo.project.name));
  });

  test('the project screen carries no branch mention; the active chat switches through its overflow menu, a history chat stays read-only', async ({
    page,
  }, testInfo) => {
    const ids = idsFor(testInfo.project.name);
    const mobile = testInfo.project.name === 'mobile';
    if (mobile) await page.setViewportSize(MOBILE_VIEWPORT);
    await mockBranchRoute(page, ids.projectId);
    const main = page.getByRole('main');

    // ── The project screen: about the repository as a whole, no branch
    //    picker or mention of one in the Repository card ──
    await page.goto(`/${E2E_SLUG}/code/${ids.projectId}`);
    await expect(page.getByRole('heading', { level: 1, name: ids.projectName })).toBeVisible();
    const repository = main.locator('section', {
      has: page.getByRole('heading', { level: 2, name: 'Repository' }),
    });
    await expect(repository).toContainText('acme/billing-service');
    await expect(repository.getByRole('button')).toHaveCount(0);
    await expect(repository.getByText(/main|feature/)).toHaveCount(0);
    await shot(page, testInfo, 'branch-switcher-project-no-mention.png');

    // ── The active chat's title bar: a plain read-only label, and
    //    "Switch branch" in the overflow menu opens the picker as a
    //    modal — the only path, at any width ──
    await page.goto(`/${E2E_SLUG}/chat/${ids.activeChatId}`);
    await expect(page.getByRole('heading', { name: ids.activeChatTitle })).toBeVisible();
    const chatBranch = main.locator('[data-testid="chat-branch"]');
    await expect(chatBranch).toBeVisible();
    await expect(chatBranch).toContainText('main');
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

    // ── A history chat: the plain read-only label, no switcher and no
    //    "Switch branch" entry — it can no longer send turns ──
    await page.goto(`/${E2E_SLUG}/chat/${ids.historyChatId}`);
    await expect(page.getByRole('heading', { name: ids.historyChatTitle })).toBeVisible();
    const historyBranch = main.locator('[data-testid="chat-branch"]');
    await expect(historyBranch).toBeVisible();
    await expect(historyBranch.getByRole('button')).toHaveCount(0);
    await main.getByRole('button', { name: 'More', exact: true }).click();
    await expect(page.getByRole('menuitem', { name: 'Switch branch' })).toHaveCount(0);
    await shot(page, testInfo, 'branch-switcher-history-readonly.png');
  });

  test('a dirty checkout is refused with a clear reason, and discarding lets the switch through', async ({
    page,
  }, testInfo) => {
    const ids = idsFor(testInfo.project.name);
    const mobile = testInfo.project.name === 'mobile';
    if (mobile) await page.setViewportSize(MOBILE_VIEWPORT);
    await mockDirtyThenCleanBranchRoute(page, ids.projectId);
    const main = page.getByRole('main');

    // ── Picking a branch on a dirty checkout: a modal names the problem,
    //    not an overlapping inline error, with a way through ──
    await page.goto(`/${E2E_SLUG}/chat/${ids.activeChatId}`);
    await expect(page.getByRole('heading', { name: ids.activeChatTitle })).toBeVisible();
    const chatBranch = main.locator('[data-testid="chat-branch"]');
    await expect(chatBranch).toContainText('main');
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
    const discard = blocked.getByRole('button', { name: 'Discard changes and switch to feature/x' });
    await expect(discard).toBeVisible();
    await shot(page, testInfo, 'branch-switcher-dirty-modal.png');

    // ── Discarding retries the same switch, which now goes through ──
    await discard.click();
    await expect(branchModal).toHaveCount(0);
    await expect(chatBranch).toContainText('feature/x');
    await shot(page, testInfo, 'branch-switcher-dirty-discarded.png');
  });
});
