/**
 * The chat's task list end to end, on a scripted stand-in model
 * (e2e/support/stub-model.ts): the assistant plans a task with subtasks
 * and a dependency, hands two subtasks to background sub-agents
 * (chat_delegate with `background`), and suspends on them
 * (chat_task_wait) — the turn ends with nothing running. The tasks dialog,
 * opened from the title bar's More menu, shows what is under way and what
 * is blocked, and the wait. When the sub-agents report, their tasks
 * complete, the chat wakes on its own (lib/chat/tasks/wake.ts) and the
 * open thread follows the woken turn; the dialog then lists everything
 * finished, in the order it finished, and reads as Markdown. Also a pass
 * at phone width.
 *
 * The rules — what starts when, what a cancel takes along, when a wait
 * fires, how the dialog groups and what the owner may press — are
 * lib/chat/tasks/graph.test.ts's, tools.test.ts's and
 * tasks-dialog.model.test.ts's.
 */

import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { Page, TestInfo } from '@playwright/test';
import { test, expect } from './fixtures';
import {
  addStubModel,
  releaseStub,
  removeModel,
  scripted,
  type StubStep,
} from './support/stub-model';
import { createChat, settled, startTurn } from './support/chat';

// Adding a model to the roster is an operator's.
test.use({ roles: ['renkei-user', 'renkei-operator'] });

const PROMPT = 'Put together the Q4 release notes: what merged, and any open incidents to mention.';
const CHANGES_REPORT =
  'Merged this quarter: the tasks dialog, background sub-agents, and faster chat search.';
const INCIDENTS_REPORT = 'One open incident: INC-207, slow file-share indexing, mitigated.';
const FINAL =
  'The Q4 release notes are drafted from both reports — three features and one incident.';

async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth
  );
  expect(overflow).toBeLessThanOrEqual(0);
}

function shooter(page: Page, testInfo: TestInfo) {
  return (name: string) =>
    page.screenshot({
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

async function openTasks(page: Page) {
  await page.getByRole('main').getByRole('button', { name: 'More', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Tasks' }).click();
  const dialog = page.getByRole('dialog', { name: 'Tasks' });
  // (The list is read on open: a cold route can take a moment.)
  await expect(dialog.locator('[data-tasks-summary]')).toBeVisible({ timeout: 15_000 });
  return dialog;
}

test.describe('chat tasks', () => {
  test('the assistant plans, suspends on background sub-agents, and wakes when they report @smoke', async ({
    page,
    person: _person,
  }, testInfo) => {
    const tag = `${testInfo.project.name}-${randomUUID().slice(0, 6)}`;
    const hold = `tasks-${tag}`;
    const model = await addStubModel(page.request, `${tag}-main`);
    // Each sub-agent's report is held until the test lets it go, so the
    // dialog can be seen while they work.
    const subagent = (task: string, report: string) =>
      scripted(task, [{ text: report, until: hold }]);
    const steps: StubStep[] = [
      {
        text: 'I’ll plan this out.',
        tools: [{ name: 'chat_task_create', input: { title: 'Write the Q4 release notes' } }],
      },
      {
        tools: [
          { name: 'chat_task_create', input: { title: 'Collect merged changes', parent: 1 } },
          { name: 'chat_task_create', input: { title: 'Check open incidents', parent: 1 } },
        ],
      },
      {
        tools: [
          {
            name: 'chat_task_create',
            input: {
              title: 'Draft the notes',
              parent: 1,
              depends_on: [2, 3],
              detail: 'One paragraph per feature, then incidents.',
            },
          },
          { name: 'chat_task_update', input: { task: 1, status: 'in_progress' } },
        ],
      },
      {
        tools: [
          {
            name: 'chat_delegate',
            input: {
              task: subagent('List what merged this quarter.', CHANGES_REPORT),
              task_id: 2,
              background: true,
            },
          },
          {
            name: 'chat_delegate',
            input: {
              task: subagent('List open incidents worth mentioning.', INCIDENTS_REPORT),
              task_id: 3,
              background: true,
            },
          },
        ],
      },
      {
        text: 'Two sub-agents are gathering the changes and the incidents; I’ll pick this up when they report.',
        tools: [{ name: 'chat_task_wait', input: { tasks: [2, 3], timeout_minutes: 10 } }],
      },
      // ── Woken, with both reports in the note ──
      {
        tools: [
          {
            name: 'chat_task_update',
            input: {
              task: 4,
              status: 'in_progress',
              progress: 50,
              note: 'Writing from both reports',
            },
          },
        ],
      },
      {
        tools: [
          {
            name: 'chat_task_complete',
            input: { task: 4, result: 'Drafted: three features, one incident.' },
          },
        ],
      },
      {
        tools: [{ name: 'chat_task_complete', input: { task: 1, result: 'Release notes ready.' } }],
      },
      { text: FINAL },
    ];
    const shot = shooter(page, testInfo);
    try {
      const chatId = await createChat(page.request, {
        llmModelId: model,
        title: `Q4 release notes ${tag}`,
      });
      await startTurn(page.request, chatId, scripted(PROMPT, steps), model);
      // The reply ends on chat_task_wait, with the sub-agents still held.
      await settled(page.request, chatId);

      const main = page.getByRole('main');
      await page.goto(`/chat/${chatId}`);
      await expect(main.getByText('Two sub-agents are gathering')).toBeVisible();

      // ── While the sub-agents work: under way, blocked, and the wait ──
      let dialog = await openTasks(page);
      await expect(dialog.locator('[data-tasks-summary]')).toHaveText('0 of 4 completed');
      const inProgress = dialog.locator('[data-tasks-section="in_progress"]');
      await expect(inProgress.locator('[data-task]')).toHaveCount(3);
      const waiting = dialog.locator('[data-tasks-section="waiting"]');
      await expect(waiting.locator('[data-task="4"]')).toContainText('Blocked');
      await expect(waiting.locator('[data-task="4"]')).toContainText('waiting on #2, #3');
      await expect(dialog.locator('[data-tasks-wait]')).toContainText('waiting on all of #2, #3');
      await expectNoHorizontalOverflow(page);
      await shot('chat-tasks-in-progress.png');

      await dialog.getByRole('tab', { name: 'Markdown' }).click();
      await expect(dialog.locator('[data-tasks-markdown]')).toContainText(
        '- [ ] **#4** Draft the notes — _blocked_, after #2, #3'
      );
      await shot('chat-tasks-markdown-in-progress.png');
      await dialog.getByRole('button', { name: 'Close' }).click();
      await expect(dialog).toHaveCount(0);

      // ── The same, at phone width ──
      const desktop = page.viewportSize();
      await page.setViewportSize({ width: 390, height: 844 });
      dialog = await openTasks(page);
      await expect(dialog.locator('[data-tasks-wait]')).toBeVisible();
      await expectNoHorizontalOverflow(page);
      await shot('chat-tasks-in-progress-mobile.png');
      await dialog.getByRole('button', { name: 'Close' }).click();
      if (desktop) await page.setViewportSize(desktop);

      // ── The sub-agents report: the chat wakes and the thread follows ──
      await releaseStub(page.request, hold);
      await expect(main.getByText('Task wait finished', { exact: false })).toBeVisible({
        timeout: 30_000,
      });
      await expect(main.getByText(FINAL)).toBeVisible({ timeout: 30_000 });
      await settled(page.request, chatId);

      dialog = await openTasks(page);
      await expect(dialog.locator('[data-tasks-summary]')).toHaveText('4 of 4 completed');
      const finished = dialog.locator('[data-tasks-section="finished"] [data-task]');
      // In the order they finished: the sub-agents' two, the draft, then the parent last.
      await expect(finished).toHaveCount(4);
      await expect(finished.nth(2)).toHaveAttribute('data-task', '4');
      await expect(finished.nth(3)).toHaveAttribute('data-task', '1');
      await expect(dialog.locator('[data-tasks-wait]')).toHaveCount(0);
      await shot('chat-tasks-finished.png');
      await dialog.getByRole('tab', { name: 'Markdown' }).click();
      await expect(dialog.locator('[data-tasks-markdown]')).toContainText(
        '- [x] **#1** Write the Q4 release notes'
      );
      await expect(dialog.locator('[data-tasks-markdown]')).toContainText(CHANGES_REPORT);
      await shot('chat-tasks-markdown.png');
      await dialog.getByRole('button', { name: 'Close' }).click();

      // ── Phone width ──
      await page.setViewportSize({ width: 390, height: 844 });
      await page.reload();
      await expect(main.getByText(FINAL)).toBeVisible();
      await expectNoHorizontalOverflow(page);
      dialog = await openTasks(page);
      await expect(dialog.locator('[data-tasks-section="finished"] [data-task]')).toHaveCount(4);
      await expectNoHorizontalOverflow(page);
      await shot('chat-tasks-mobile.png');
      await dialog.getByRole('tab', { name: 'Markdown' }).click();
      await expectNoHorizontalOverflow(page);
      await shot('chat-tasks-markdown-mobile.png');
    } finally {
      await releaseStub(page.request, hold).catch(() => {});
      await removeModel(page.request, model);
    }
  });
});
