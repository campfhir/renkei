/**
 * The code pane's tree: creating, renaming and deleting a file (the
 * per-row "⋯" menu and the root "New file" button, against …/files —
 * POST create, PATCH rename, DELETE remove), a deleted file staying in
 * the tree as a struck-through "ghost" row tagged D rather than
 * vanishing, and a gitignored entry (node_modules, seeded by the stub)
 * drawn dimmed rather than hidden. Real routes and the real (stubbed)
 * sandbox worker throughout — sandbox-stub.mjs's ls/rm/mv/git-diff verbs
 * carry the same overlay a real checkout would, so this exercises the
 * whole path, not a page.route double of it.
 *
 * Own tenant fixtures under the shared e2e/seed.ts tenant, with
 * project/chat ids distinct from code.spec.ts's and
 * branch-switcher.spec.ts's own so the three never collide running side
 * by side (AGENTS.md: a spec that writes data through the UI needs its
 * own tenant scope, not the shared seeded one).
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
    projectId: `55555555-5555-4555-8555-5555555555${digit}1`,
    chatId: `55555555-5555-4555-8555-5555555555${digit}2`,
    projectName: `File management project (${digit})`,
    chatTitle: `File management chat (${digit})`,
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
    await client.query('DELETE FROM chats WHERE id = $1', [ids.chatId]);
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
      [ids.chatId, E2E_TENANT_ID, E2E_SUBJECT, ids.projectId, ids.chatTitle]
    );
    await client.query('UPDATE chat_projects SET active_chat_id = $1 WHERE id = $2', [
      ids.chatId,
      ids.projectId,
    ]);
  } finally {
    await client.end();
  }
}

/** Mirrors code.spec.ts's own seedCheckout: a real clone on the stub worker. */
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
    await client.query('DELETE FROM chats WHERE id = $1', [ids.chatId]);
    await client.query('DELETE FROM chat_projects WHERE id = $1', [ids.projectId]);
  } finally {
    await client.end();
  }
}

async function shot(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  await page.screenshot({
    path: path.join(import.meta.dirname, '..', 'test-results', 'screens', testInfo.project.name, name),
    fullPage: false,
  });
}

test.describe('code pane file management', () => {
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

  test('new file, rename, delete — a deleted file ghosts in as D, node_modules stays dimmed', async ({
    page,
  }, testInfo) => {
    const ids = idsFor(testInfo.project.name);
    const mobile = testInfo.project.name === 'mobile';
    if (mobile) await page.setViewportSize(MOBILE_VIEWPORT);
    const main = page.getByRole('main');

    await page.goto(`/${E2E_SLUG}/chat/${ids.chatId}`);
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

    // ── Rename it, through the row's "⋯" menu ──
    await tree.getByRole('button', { name: 'More for notes.md' }).click();
    await page.getByRole('menu').getByRole('menuitem', { name: 'Rename' }).click();
    const renameDialog = page.getByRole('dialog', { name: 'Rename' });
    await expect(renameDialog.getByLabel('New name')).toHaveValue('notes.md');
    await renameDialog.getByLabel('New name').fill('notes-renamed.md');
    await renameDialog.getByRole('button', { name: 'Rename' }).click();
    await expect(renameDialog).toHaveCount(0);
    await expect(tree.getByRole('button', { name: /^notes\.md/ })).toHaveCount(0);
    await expect(tree.getByRole('button', { name: /^notes-renamed\.md/ })).toBeVisible();
    await shot(page, testInfo, 'code-tree-renamed.png');

    // ── Delete it — the tree simply loses the row (never committed, no
    //    ghost for a file that never existed on a branch) ──
    await tree.getByRole('button', { name: 'More for notes-renamed.md' }).click();
    page.once('dialog', (dialog) => void dialog.accept());
    await page.getByRole('menu').getByRole('menuitem', { name: 'Delete' }).click();
    await expect(tree.getByRole('button', { name: /^notes-renamed\.md/ })).toHaveCount(0);

    // ── Deleting a tracked file instead leaves a struck-through "D" ghost
    //    row in its place, and the pane's own Changed list picks it up ──
    await tree.getByRole('button', { name: 'More for README.md' }).click();
    page.once('dialog', (dialog) => void dialog.accept());
    await page.getByRole('menu').getByRole('menuitem', { name: 'Delete' }).click();
    // The live row and its ghost both key off README.md's name, so wait
    // for the (now stale) live listing's own row to clear the tree
    // before looking for the ghost that replaces it — the two refresh
    // independently (the tree's own reload vs. the pane's Changed list)
    // and can briefly overlap.
    await expect(tree.getByRole('button', { name: /^README\.md/ })).toHaveCount(0);
    const ghost = tree.getByText('README.md', { exact: true });
    await expect(ghost).toBeVisible();
    await expect(ghost).toHaveCSS('text-decoration-line', 'line-through');
    await expect(tree.getByText('D', { exact: true })).toBeVisible();
    await expect(main.getByText('Changed · not committed')).toBeVisible();
    const changedRow = main.getByRole('button', { name: /README\.md/ }).first();
    await expect(changedRow).toBeVisible();
    await expect(changedRow.locator('span').first()).toHaveAttribute(
      'title',
      'Deleted, not committed'
    );
    await shot(page, testInfo, 'code-tree-deleted-ghost.png');
  });
});
