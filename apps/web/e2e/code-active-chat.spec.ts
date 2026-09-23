/**
 * One active chat per code project (lib/code/active-chat.ts): the seeded
 * chat continues; New chat on the project page makes it history — no
 * composer, a notice with the way to the active chat, a "history" tag in
 * the title bar and the menu, its send refused by the route — and the
 * project page lists the active chat apart from the previous ones. A new
 * chat is refused while the active chat is mid-reply, and the page says
 * so. Then the same notice at phone width. The sandbox worker is the
 * stub (sandbox-stub.mjs); no checkout is needed for any of this.
 */

import { test, expect, type Page } from '@playwright/test';
import { Client } from 'pg';
import { E2E_SLUG, E2E_SUBJECT, E2E_TENANT_ID } from './seed';

test.use({
  // The mobile project's device descriptor asks for WebKit, which is not
  // installed here; the pinned Chromium runs every project.
  browserName: 'chromium',
  launchOptions: {
    executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    args: ['--no-sandbox'],
  },
});

/** Per-project fixtures: the Playwright projects share one database. */
function idsFor(project: string) {
  const digit = { 'desktop-light': '1', 'desktop-dark': '2', mobile: '3' }[project] ?? '4';
  return {
    projectId: `77777777-7777-4777-8777-7777777777${digit}1`,
    chatId: `77777777-7777-4777-8777-7777777777${digit}2`,
    projectName: `Ledger service (${digit})`,
    chatTitle: `Where do refunds get posted? (${digit})`,
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

async function seed(ids: ReturnType<typeof idsFor>): Promise<void> {
  await clean(ids);
  const client = await db();
  try {
    await client.query(
      `INSERT INTO chat_projects
         (id, tenant_id, owner_subject, name, description, kind, repo_provider, repo_full_name, repo_branch)
       VALUES ($1, $2, $3, $4, 'Postings, refunds and the month-end close.', 'code', 'atlassian-bitbucket', 'acme/ledger-service', 'main')`,
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

/** A reply in progress in the chat, as the runner leaves one while it works. */
async function seedRunningTurn(chatId: string): Promise<void> {
  const client = await db();
  try {
    await client.query(
      `INSERT INTO chat_turns (tenant_id, chat_id, status) VALUES ($1, $2, 'running')`,
      [E2E_TENANT_ID, chatId]
    );
  } finally {
    await client.end();
  }
}

/** The page never scrolls sideways. */
async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth
  );
  expect(overflow).toBeLessThanOrEqual(0);
}

test.describe('code project active chat', () => {
  // eslint-disable-next-line no-empty-pattern
  test.beforeEach(async ({}, testInfo) => {
    await seed(idsFor(testInfo.project.name));
  });
  // eslint-disable-next-line no-empty-pattern
  test.afterEach(async ({}, testInfo) => {
    await clean(idsFor(testInfo.project.name));
  });

  test('a new chat makes the previous one history', async ({ page }, testInfo) => {
    const ids = idsFor(testInfo.project.name);
    const mobile = testInfo.project.name === 'mobile';
    const main = page.getByRole('main');
    const menu = page.getByRole('navigation', { name: 'Application' });
    const composer = main.getByPlaceholder('Message Renkei');

    // ── The seeded chat is the active one: it has its composer, no notice ──
    await page.goto(`/${E2E_SLUG}/chat/${ids.chatId}`);
    await expect(page.getByRole('heading', { name: ids.chatTitle })).toBeVisible({
      timeout: 30_000,
    });
    await expect(composer).toBeVisible();
    await expect(page.getByTestId('chat-history-notice')).toHaveCount(0);
    await expect(page.getByTestId('chat-tag')).toHaveCount(0);

    // ── The project page: the active chat on its own, no previous ones ──
    await page.goto(`/${E2E_SLUG}/code/${ids.projectId}`);
    await expect(
      main.getByRole('heading', { level: 2, name: 'Chats in this project' })
    ).toBeVisible({ timeout: 30_000 });
    await expect(
      main.getByTestId('project-active-chat').getByRole('link', { name: ids.chatTitle })
    ).toBeVisible();
    await expect(main.getByTestId('project-previous-chats')).toHaveCount(0);

    // ── New chat: the browser lands in it, with a composer ──
    await main.getByRole('button', { name: 'New chat' }).click();
    await expect(page).toHaveURL(new RegExp(`/${E2E_SLUG}/chat/[0-9a-f-]{36}$`), {
      timeout: 30_000,
    });
    const newChatId = page.url().split('/').pop()!;
    expect(newChatId).not.toBe(ids.chatId);
    await expect(page.getByRole('heading', { name: `New chat in ${ids.projectName}` })).toBeVisible(
      { timeout: 30_000 }
    );
    await expect(composer).toBeVisible();
    await expect(page.getByTestId('chat-history-notice')).toHaveCount(0);

    // ── The previous chat is history: no composer, the notice, the tag ──
    await page.goto(`/${E2E_SLUG}/chat/${ids.chatId}`);
    await expect(page.getByRole('heading', { name: ids.chatTitle })).toBeVisible({
      timeout: 30_000,
    });
    const notice = page.getByTestId('chat-history-notice');
    await expect(notice).toBeVisible();
    await expect(notice).toContainText('This chat is history.');
    await expect(notice.getByRole('link', { name: 'Open the active chat' })).toHaveAttribute(
      'href',
      `/${E2E_SLUG}/chat/${newChatId}`
    );
    await expect(notice.getByRole('button', { name: 'Start a new chat' })).toBeVisible();
    await expect(composer).toHaveCount(0);
    await expect(page.getByTestId('chat-tag')).toHaveText('history');
    await expectNoHorizontalOverflow(page);
    await page.screenshot({
      path: `test-results/screens/${testInfo.project.name}/code-chat-history.png`,
    });

    // ── And the route refuses a send there, whatever the page shows ──
    const refused = await page.request.post(
      `/api/tenant/${E2E_TENANT_ID}/chat/chats/${ids.chatId}/turns`,
      { data: { text: 'One more thing' } }
    );
    expect(refused.status()).toBe(409);
    expect((await refused.json()).code).toBe('chat-history');

    // ── The menu tags it; the project page lists it under Previous chats ──
    if (mobile) await page.getByRole('button', { name: 'Open menu' }).click();
    const row = menu.getByRole('link', { name: ids.chatTitle });
    await expect(row).toBeVisible();
    await expect(row.getByTestId('chat-history-tag')).toHaveText('history');
    if (mobile) await page.getByRole('button', { name: 'Close menu' }).click();

    await page.goto(`/${E2E_SLUG}/code/${ids.projectId}`);
    await expect(
      main.getByRole('heading', { level: 2, name: 'Chats in this project' })
    ).toBeVisible({ timeout: 30_000 });
    const active = main.getByTestId('project-active-chat');
    await expect(active.getByRole('link', { name: 'New chat' })).toHaveAttribute(
      'href',
      `/${E2E_SLUG}/chat/${newChatId}`
    );
    await expect(active.getByRole('link', { name: ids.chatTitle })).toHaveCount(0);
    await expect(
      main.getByTestId('project-previous-chats').getByRole('link', { name: ids.chatTitle })
    ).toBeVisible();
    await page.screenshot({
      path: `test-results/screens/${testInfo.project.name}/code-project-active-chat.png`,
    });

    // ── The Open the active chat link goes where it says ──
    await page.goto(`/${E2E_SLUG}/chat/${ids.chatId}`);
    await page
      .getByTestId('chat-history-notice')
      .getByRole('link', { name: 'Open the active chat' })
      .click();
    await expect(page).toHaveURL(`/${E2E_SLUG}/chat/${newChatId}`);
    await expect(composer).toBeVisible({ timeout: 30_000 });
  });

  test('no new chat while the active chat is replying', async ({ page }, testInfo) => {
    const ids = idsFor(testInfo.project.name);
    const main = page.getByRole('main');
    await seedRunningTurn(ids.chatId);

    await page.goto(`/${E2E_SLUG}/code/${ids.projectId}`);
    await expect(
      main.getByRole('heading', { level: 2, name: 'Chats in this project' })
    ).toBeVisible({ timeout: 30_000 });
    await main.getByRole('button', { name: 'New chat' }).click();
    const alert = main.getByRole('alert');
    await expect(alert).toContainText('The active chat is still replying');
    await expect(page).toHaveURL(`/${E2E_SLUG}/code/${ids.projectId}`);
    // The active chat is still the seeded one.
    await expect(
      main.getByTestId('project-active-chat').getByRole('link', { name: ids.chatTitle })
    ).toBeVisible();
    await expect(main.getByTestId('project-previous-chats')).toHaveCount(0);
  });

  test('the history notice at phone width', async ({ page }, testInfo) => {
    const ids = idsFor(testInfo.project.name);
    await page.setViewportSize({ width: 390, height: 844 });
    // A second chat through the API, the way the page's button does it.
    const created = await page.request.post(`/api/tenant/${E2E_TENANT_ID}/chat/chats`, {
      data: { projectId: ids.projectId },
    });
    expect(created.status()).toBe(201);
    const { chatId: newChatId }: { chatId: string } = await created.json();

    await page.goto(`/${E2E_SLUG}/chat/${ids.chatId}`);
    const notice = page.getByTestId('chat-history-notice');
    await expect(notice).toBeVisible({ timeout: 30_000 });
    await expect(notice.getByRole('link', { name: 'Open the active chat' })).toHaveAttribute(
      'href',
      `/${E2E_SLUG}/chat/${newChatId}`
    );
    await expect(page.getByRole('main').getByPlaceholder('Message Renkei')).toHaveCount(0);
    await expectNoHorizontalOverflow(page);
    await page.screenshot({
      path: `test-results/screens/${testInfo.project.name}/code-chat-history-phone.png`,
    });
  });
});
