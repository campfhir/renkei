/**
 * Switching a code project's checkout branch, from the project screen's
 * Repository card and from the active chat's title bar — the same
 * control (branch-switcher.tsx) in both places, backed by
 * …/code/projects/[projectId]/branch. The branch list and the switch
 * itself are mocked with page.route (AGENTS.md: a call that would hit a
 * real vendor/provider — GitHub/Bitbucket here — is mocked at the
 * browser edge, not against the real host); a history chat gets the
 * plain read-only label instead, since it can no longer send turns.
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

  test('switches from the project screen and the active chat, stays read-only on history', async ({
    page,
  }, testInfo) => {
    const ids = idsFor(testInfo.project.name);
    const mobile = testInfo.project.name === 'mobile';
    await mockBranchRoute(page, ids.projectId);
    const main = page.getByRole('main');

    // ── The project screen: the Repository card's branch is a switcher ──
    await page.goto(`/${E2E_SLUG}/code/${ids.projectId}`);
    await expect(page.getByRole('heading', { level: 1, name: ids.projectName })).toBeVisible();
    const repository = main.locator('section', {
      has: page.getByRole('heading', { level: 2, name: 'Repository' }),
    });
    const projectSwitcher = repository.getByRole('button', { name: /main/ });
    await expect(projectSwitcher).toBeVisible();
    await projectSwitcher.click();
    const projectListbox = page.getByRole('listbox', { name: 'Switch branch' });
    await expect(projectListbox.getByRole('option', { name: 'feature/x' })).toBeVisible();
    await shot(page, testInfo, 'branch-switcher-project-open.png');
    await projectListbox.getByRole('option', { name: 'feature/x' }).click();
    await expect(repository.getByRole('button', { name: /feature\/x/ })).toBeVisible();
    await shot(page, testInfo, 'branch-switcher-project-switched.png');

    // ── The active chat's title bar: the same control ──
    await page.goto(`/${E2E_SLUG}/chat/${ids.activeChatId}`);
    await expect(page.getByRole('heading', { name: ids.activeChatTitle })).toBeVisible();
    const chatBranch = main.locator('[data-testid="chat-branch"]');
    const chatSwitcher = chatBranch.getByRole('button');
    await expect(chatSwitcher).toBeVisible();
    await chatSwitcher.click();
    const chatListbox = page.getByRole('listbox', { name: 'Switch branch' });
    await expect(chatListbox.getByRole('option', { name: 'feature/x' })).toBeVisible();
    await chatListbox.getByRole('option', { name: 'feature/x' }).click();
    await expect(chatBranch.getByText('feature/x')).toBeVisible();
    await shot(page, testInfo, 'branch-switcher-chat-switched.png');

    // ── A history chat: the plain read-only label, no switcher ──
    await page.goto(`/${E2E_SLUG}/chat/${ids.historyChatId}`);
    await expect(page.getByRole('heading', { name: ids.historyChatTitle })).toBeVisible();
    const historyBranch = main.locator('[data-testid="chat-branch"]');
    await expect(historyBranch).toBeVisible();
    await expect(historyBranch.getByRole('button')).toHaveCount(0);
    await shot(page, testInfo, 'branch-switcher-history-readonly.png');

    if (!mobile) return;

    // ── Mobile: the same picker, at phone width ──
    await page.goto(`/${E2E_SLUG}/code/${ids.projectId}`);
    await page.setViewportSize(MOBILE_VIEWPORT);
    await expect(page.getByRole('heading', { level: 1, name: ids.projectName })).toBeVisible();
    await repository.getByRole('button', { name: /feature\/x|main/ }).click();
    await expect(page.getByRole('listbox', { name: 'Switch branch' })).toBeVisible();
    await shot(page, testInfo, 'branch-switcher-mobile.png');
  });
});
