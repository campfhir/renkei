/**
 * Concurrent chats in a code project (lib/code/turn.ts, migration 158):
 * every chat works in a git worktree of its own, so any number run at
 * once. Two seeded chats both have composers and no "history" anywhere;
 * the project page lists both; New chat is not refused while another
 * chat is mid-reply; a file made in one chat's worktree shows in that
 * chat's tree and not the other's; deleting a chat takes its worktree
 * with it. Then the same page at phone width. The sandbox worker is the
 * stub (sandbox-stub.mjs), which answers `worktree` the way the real
 * worker does.
 *
 * Own project and chat ids per Playwright project: the three share one
 * database.
 */

import { test, expect, type Page } from '@playwright/test';
import { Client } from 'pg';
import { E2E_SUBJECT } from './seed';
import { giveChatWorktree } from './worktree';

test.use({
  // The mobile project's device descriptor asks for WebKit, which is not
  // installed here; the pinned Chromium runs every project.
  browserName: 'chromium',
  launchOptions: {
    executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    args: ['--no-sandbox'],
  },
});

const WORKER = process.env.SANDBOX_WORKER_URL ?? 'http://127.0.0.1:8092';
const WORKER_HEADERS = {
  authorization: `Bearer ${process.env.SANDBOX_WORKER_API_KEY ?? 'e2e-sandbox-key'}`,
  'content-type': 'application/json',
};

function idsFor(project: string) {
  const digit = { 'desktop-light': '1', 'desktop-dark': '2', mobile: '3' }[project] ?? '4';
  return {
    projectId: `9b9b9b9b-9b9b-49b9-89b9-9b9b9b9b9b${digit}1`,
    firstChatId: `9b9b9b9b-9b9b-49b9-89b9-9b9b9b9b9b${digit}2`,
    secondChatId: `9b9b9b9b-9b9b-49b9-89b9-9b9b9b9b9b${digit}3`,
    projectName: `Ledger service (${digit})`,
    firstChatTitle: `Where do refunds get posted? (${digit})`,
    secondChatTitle: `Month-end close checklist (${digit})`,
  };
}

async function db(): Promise<Client> {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  return client;
}

async function clean(ids: ReturnType<typeof idsFor>): Promise<void> {
  const client = await db();
  try {
    // Chats started through the page in a test go with the project.
    await client.query('DELETE FROM chats WHERE project_id = $1', [ids.projectId]);
    await client.query('DELETE FROM chat_projects WHERE id = $1', [ids.projectId]);
  } finally {
    await client.end();
  }
}

/** The project's base clone on the stub, ready, and both chats' worktrees off it. */
async function seed(ids: ReturnType<typeof idsFor>): Promise<void> {
  await clean(ids);
  const target = { subject: `code-project:${ids.projectId}` };
  const cloned = await fetch(`${WORKER}/v1/workspaces/clone`, {
    method: 'POST',
    headers: WORKER_HEADERS,
    body: JSON.stringify({
      ...target,
      provider: 'atlassian-bitbucket',
      repoFullName: 'acme/ledger-service',
      branch: 'main',
      cloneUrl: 'https://bitbucket.org/acme/ledger-service.git',
      gitProxy: {
        base: 'http://127.0.0.1:8096/git/e2e/bitbucket.org/',
        insteadOf: 'https://bitbucket.org/',
      },
    }),
  });
  const { workspace }: { workspace: { id: string } } = await cloned.json();
  for (let tries = 0; tries < 20; tries += 1) {
    const got = await fetch(`${WORKER}/v1/workspaces/get`, {
      method: 'POST',
      headers: WORKER_HEADERS,
      body: JSON.stringify({ ...target, id: workspace.id }),
    });
    const state: { workspace: { status: string } } = await got.json();
    if (state.workspace.status === 'ready') break;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  const client = await db();
  try {
    await client.query(
      `INSERT INTO chat_projects\n         (id, owner_subject, name, description, kind, repo_provider, repo_full_name, repo_branch, workspace_id)\n       VALUES ($1, $2, $3, 'Postings, refunds and the month-end close.', 'code', 'atlassian-bitbucket', 'acme/ledger-service', 'main', $4)`,
      [ids.projectId, E2E_SUBJECT, ids.projectName, workspace.id]
    );
    for (const [chatId, title] of [
      [ids.firstChatId, ids.firstChatTitle],
      [ids.secondChatId, ids.secondChatTitle],
    ] as const) {
      await client.query(
        `INSERT INTO chats (id, owner_subject, project_id, title, last_message_at)\n         VALUES ($1, $2, $3, $4, NOW())`,
        [chatId, E2E_SUBJECT, ids.projectId, title]
      );
      await giveChatWorktree(client, { projectId: ids.projectId, baseId: workspace.id, chatId });
    }
  } finally {
    await client.end();
  }
}

/** A reply in progress in the chat, as the runner leaves one while it works. */
async function seedRunningTurn(chatId: string): Promise<void> {
  const client = await db();
  try {
    await client.query(`INSERT INTO chat_turns (chat_id, status) VALUES ($1, 'running')`, [chatId]);
  } finally {
    await client.end();
  }
}

async function worktreeOf(chatId: string): Promise<string> {
  const client = await db();
  try {
    const { rows } = await client.query<{ workspace_id: string }>(
      'SELECT workspace_id FROM chats WHERE id = $1',
      [chatId]
    );
    return rows[0]!.workspace_id;
  } finally {
    await client.end();
  }
}

/** The entry paths of a tree listing's JSON. */
function entryPaths(body: unknown): string[] {
  if (typeof body !== 'object' || body === null || !('entries' in body)) return [];
  const { entries } = body;
  if (!Array.isArray(entries)) return [];
  return entries.flatMap((entry: unknown) =>
    typeof entry === 'object' && entry !== null && 'path' in entry && typeof entry.path === 'string'
      ? [entry.path]
      : []
  );
}

/** The page never scrolls sideways. */
async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth
  );
  expect(overflow).toBeLessThanOrEqual(0);
}

test.describe('code project concurrent chats', () => {
  // eslint-disable-next-line no-empty-pattern
  test.beforeEach(async ({}, testInfo) => {
    await seed(idsFor(testInfo.project.name));
  });
  // eslint-disable-next-line no-empty-pattern
  test.afterEach(async ({}, testInfo) => {
    await clean(idsFor(testInfo.project.name));
  });

  test('two chats in one project both continue, and the project lists both', async ({
    page,
  }, testInfo) => {
    const ids = idsFor(testInfo.project.name);
    const main = page.getByRole('main');
    const composer = main.getByPlaceholder('Message Renkei');

    for (const [chatId, title] of [
      [ids.firstChatId, ids.firstChatTitle],
      [ids.secondChatId, ids.secondChatTitle],
    ] as const) {
      await page.goto(`/chat/${chatId}`);
      await expect(page.getByRole('heading', { name: title })).toBeVisible({ timeout: 30_000 });
      await expect(composer).toBeVisible();
      await expect(page.getByTestId('chat-history-notice')).toHaveCount(0);
      await expect(page.getByTestId('chat-tag')).toHaveCount(0);
    }
    await expectNoHorizontalOverflow(page);
    await page.screenshot({
      path: `test-results/screens/${testInfo.project.name}/code-chat-concurrent.png`,
    });

    await page.goto(`/code/${ids.projectId}`);
    await expect(
      main.getByRole('heading', { level: 2, name: 'Chats in this project' })
    ).toBeVisible({ timeout: 30_000 });
    const list = main.getByTestId('project-code-chats');
    await expect(list.getByRole('link', { name: ids.firstChatTitle })).toBeVisible();
    await expect(list.getByRole('link', { name: ids.secondChatTitle })).toBeVisible();
    await expect(main.getByText('worktree of its own')).toBeVisible();
    await expectNoHorizontalOverflow(page);
    await page.screenshot({
      path: `test-results/screens/${testInfo.project.name}/code-project-chats.png`,
    });
  });

  test('a new chat starts while another is replying, and defaults to auto mode on', async ({
    page,
  }, testInfo) => {
    const ids = idsFor(testInfo.project.name);
    const main = page.getByRole('main');
    await seedRunningTurn(ids.firstChatId);

    await page.goto(`/code/${ids.projectId}`);
    await expect(
      main.getByRole('heading', { level: 2, name: 'Chats in this project' })
    ).toBeVisible({ timeout: 30_000 });
    await main.getByRole('button', { name: 'New chat' }).click();
    await expect(page).toHaveURL(new RegExp(`/chat/[0-9a-f-]{36}$`), { timeout: 30_000 });
    expect(page.url().split('/').pop()).not.toBe(ids.firstChatId);

    const autoToggle = page.getByRole('button', { name: 'Auto mode on' });
    await expect(autoToggle).toBeVisible({ timeout: 30_000 });
    await expect(autoToggle).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByTestId('chat-history-notice')).toHaveCount(0);

    // The first chat is still there to continue, mid-reply and all.
    await page.goto(`/chat/${ids.firstChatId}`);
    await expect(page.getByRole('heading', { name: ids.firstChatTitle })).toBeVisible({
      timeout: 30_000,
    });
    await expect(page.getByTestId('chat-history-notice')).toHaveCount(0);
  });

  test('a file made in one chat’s worktree is in that chat’s tree and not the other’s', async ({
    page,
  }, testInfo) => {
    const ids = idsFor(testInfo.project.name);
    const file = `only-in-first-${testInfo.project.name}.txt`;
    const tree = (chatId: string) =>
      page.request.get(`/api/code/projects/${ids.projectId}/chats/${chatId}/tree?path=`);
    const names = async (chatId: string): Promise<string[]> => {
      const response = await tree(chatId);
      expect(response.ok()).toBe(true);
      return entryPaths(await response.json());
    };

    const created = await page.request.post(
      `/api/code/projects/${ids.projectId}/chats/${ids.firstChatId}/files`,
      { data: { path: file, content: 'refunds are posted to 2410\n' } }
    );
    expect(created.ok()).toBe(true);

    expect(await names(ids.firstChatId)).toContain(file);
    expect(await names(ids.secondChatId)).not.toContain(file);
    // Nor in the project's base clone, which no chat edits.
    const base = await page.request.get(`/api/code/projects/${ids.projectId}/tree?path=`);
    expect(entryPaths(await base.json())).not.toContain(file);

    // A chat that is not this project's is not reachable through it.
    const stranger = await page.request.get(
      `/api/code/projects/${ids.projectId}/chats/00000000-0000-4000-8000-000000000000/tree?path=`
    );
    expect(stranger.status()).toBe(404);
  });

  test('deleting a chat takes its worktree with it, and only its own', async ({ page }, testInfo) => {
    const ids = idsFor(testInfo.project.name);
    const target = { subject: `code-project:${ids.projectId}` };
    const first = await worktreeOf(ids.firstChatId);
    const second = await worktreeOf(ids.secondChatId);
    expect(first).not.toBe(second);
    const exists = async (id: string): Promise<boolean> => {
      const got = await fetch(`${WORKER}/v1/workspaces/get`, {
        method: 'POST',
        headers: WORKER_HEADERS,
        body: JSON.stringify({ ...target, id }),
      });
      return got.ok;
    };
    expect(await exists(first)).toBe(true);

    const deleted = await page.request.delete(`/api/chat/chats/${ids.firstChatId}`);
    expect(deleted.ok()).toBe(true);
    expect(await exists(first)).toBe(false);
    expect(await exists(second)).toBe(true);
  });
});
