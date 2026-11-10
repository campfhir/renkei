/**
 * Concurrent chats in a code project (lib/code/turn.ts, migration 158):
 * every chat works in a git worktree of its own, so any number run at
 * once. Two seeded chats both open with composers and no "history"
 * anywhere; the project page lists both; New chat is not refused while
 * another chat is mid-reply, and opens on auto mode.
 *
 * Which worktree each chat's tree is read from (its own, not the base clone
 * or the other chat's), that a chat outside the project is not reachable
 * through it, and that deleting a chat deletes its worktree and only its
 * own are route tests now
 * (app/api/code/projects/[projectId]/chats/[chatId]/tree/route.test.ts).
 * Real git is not needed for any of it: the isolation itself is the
 * sandbox worker's, which the browser suite only imitates with its stub
 * (sandbox-stub.mjs).
 *
 * The project and its chats are the test's own person's, made through the
 * Code routes after connecting Bitbucket (e2e/support/code-host.ts); a
 * first turn in each chat (the stand-in model, e2e/llm-stub.mjs) clones
 * the repository and gives the chat its worktree. A reply "in progress"
 * is a real turn parked on a permission ask for a tool the model called.
 */

import { randomUUID } from 'node:crypto';
import type { APIRequestContext, Page, TestInfo } from '@playwright/test';
import { test, expect } from './fixtures';
import { toolStep, removeModel, scripted } from './support/stub-model';
import { setUpCode, stageCodeProject } from './support/code-host';

// The stand-in model is staged by an operator.
test.use({ roles: ['renkei-user', 'renkei-operator'] });

interface Ids {
  projectId: string;
  firstChatId: string;
  secondChatId: string;
  projectName: string;
  firstChatTitle: string;
  secondChatTitle: string;
  modelId: string;
}

/** The project's base clone, ready, and both chats' worktrees off it. */
async function stage(page: Page, request: APIRequestContext, testInfo: TestInfo): Promise<Ids> {
  const tag = `${testInfo.project.name}-${randomUUID().slice(0, 6)}`;
  const modelId = await setUpCode(page, request, tag);
  const names = {
    projectName: `Ledger service (${tag})`,
    firstChatTitle: `Where do refunds get posted? (${tag})`,
    secondChatTitle: `Month-end close checklist (${tag})`,
  };
  const { projectId, chatIds } = await stageCodeProject(page.request, {
    name: names.projectName,
    description: 'Postings, refunds and the month-end close.',
    repository: 'acme/ledger-service',
    branch: 'main',
    chats: [names.firstChatTitle, names.secondChatTitle],
    clone: true,
    llmModelId: modelId,
  });
  return { ...names, projectId, firstChatId: chatIds[0], secondChatId: chatIds[1], modelId };
}

/**
 * A reply in progress in the chat: auto mode off, and a turn whose model
 * calls a tool, parked on the person's permission (left unanswered).
 */
async function startRunningTurn(page: Page, chatId: string, llmModelId: string): Promise<void> {
  const manual = await page.request.patch(`/api/chat/chats/${chatId}`, {
    data: { autoMode: false },
  });
  expect(manual.ok()).toBe(true);
  const asked = await page.request.post(`/api/chat/chats/${chatId}/turns`, {
    data: {
      text: scripted('Note where refunds go.', [
        toolStep('code_write_file', { path: 'NOTES.md', content: '2410\n' }),
      ]),
      llmModelId,
    },
  });
  expect(asked.status(), await asked.text()).toBe(202);
  await expect
    .poll(
      async () => {
        const view: { chat: { activeTurn: { pendingPermission: unknown } | null } } = await (
          await page.request.get(`/api/chat/chats/${chatId}`)
        ).json();
        return Boolean(view.chat.activeTurn?.pendingPermission);
      },
      { timeout: 30_000 }
    )
    .toBe(true);
}

/** The page never scrolls sideways. */
async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth
  );
  expect(overflow).toBeLessThanOrEqual(0);
}

test.describe('code project concurrent chats', () => {
  let ids: Ids;
  test.beforeEach(async ({ page, request, person: _person }, testInfo) => {
    test.setTimeout(180_000);
    ids = await stage(page, request, testInfo);
  });
  test.afterEach(async ({ page }) => {
    await removeModel(page.request, ids.modelId);
  });

  test('two chats in one project both continue, and the project lists both', async ({
    page,
  }, testInfo) => {
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
  }, _testInfo) => {
    const main = page.getByRole('main');
    await startRunningTurn(page, ids.firstChatId, ids.modelId);

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
});
