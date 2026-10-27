/**
 * An ordinary chat's sub-agent — no project, no checkout: the assistant
 * hands a reading errand to `chat_delegate` (lib/chat/chat-delegate.ts)
 * on another model of the org's, and the thread shows it the way a code
 * chat shows its own: a card of its own, marked read-only (a chat
 * sub-agent only ever reads), naming the model it ran on, with its
 * transcript a button away. The turn and the errand really run, each on a
 * scripted stand-in model (e2e/support/stub-model.ts). Also a viewport
 * pass at phone width.
 */

import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures';
import { addStubModel, removeModel } from '../support/stub-model';
import { createChat, send } from '../support/chat';

// Adding a model to the roster is an operator's.
test.use({ roles: ['renkei-user', 'renkei-operator'] });

const QUESTION = 'Which issues slipped out of the last OPS sprint?';
const TASK =
  'Read every OPS issue that was in the last closed sprint and is not Done; report each key, its status and its assignee.';
const REPORT =
  'Two issues: OPS-41 (In Progress, Priya) — rotating the Zoom webhook secret; OPS-44 (To Do, Marcus) — backfilling the file share index.';

async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth
  );
  expect(overflow).toBeLessThanOrEqual(0);
}

test.describe('ordinary chat sub-agent', () => {
  test('a plain chat shows the sub-agent card, read-only, with its transcript', async ({
    page,
    person: _person,
  }, testInfo) => {
    const tag = `${testInfo.project.name}-${randomUUID().slice(0, 6)}`;
    const fastModelLabel = `Reading model ${tag}`;
    // The sub-agent's model: it searches once, then reports.
    const fastModel = await addStubModel(page.request, `${tag}-fast`, {
      label: fastModelLabel,
      script: [
        {
          when: TASK,
          steps: [
            {
              text: 'Searching the closed sprint.',
              tools: [
                {
                  name: 'jira_search_issues',
                  input: { jql: 'project = OPS AND sprint in closedSprints() AND status != Done' },
                },
              ],
            },
            { text: REPORT },
          ],
        },
      ],
    });
    // The chat's own model: it delegates, then answers from the report.
    const mainModel = await addStubModel(page.request, `${tag}-main`, {
      script: [
        {
          when: QUESTION,
          steps: [
            {
              text: 'Let me have the sprint looked through.',
              tools: [{ name: 'chat_delegate', input: { task: TASK, model: fastModelLabel } }],
            },
            {
              text: 'Two issues slipped: OPS-41 with Priya and OPS-44 with Marcus. Both are still open.',
            },
          ],
        },
      ],
    });
    try {
      const chatId = await createChat(page.request, {
        llmModelId: mainModel,
        title: `What slipped out of the OPS sprint? ${tag}`,
      });
      await send(page.request, chatId, QUESTION, mainModel);

      const shot = (name: string) =>
        page.screenshot({
          path: path.join(
            import.meta.dirname,
            '..',
            '..',
            'test-results',
            'screens',
            testInfo.project.name,
            name
          ),
          fullPage: false,
        });
      const main = page.getByRole('main');
      await page.goto(`/chat/${chatId}`);
      await expect(main.getByText(QUESTION)).toBeVisible();

      // ── The card, folded: a chat sub-agent is read-only by nature, ran on
      //    the model the assistant picked, and reported ──
      const subagent = main.locator('details[data-subagent]');
      await expect(subagent).toContainText('Sub-agent reported');
      await expect(subagent).toContainText('read-only');
      await expect(subagent.locator('[data-subagent-model]')).toHaveText(`on ${fastModelLabel}`);
      await subagent.locator('> summary').click();
      await expect(subagent).toHaveAttribute('open', '');
      await expect(subagent.getByText('Two issues: OPS-41', { exact: false })).toBeVisible();
      await expectNoHorizontalOverflow(page);
      await shot('chat-subagent-card.png');

      // ── Its transcript opens from here, without a code project ──
      await subagent.getByRole('button', { name: 'View transcript' }).click();
      const dialog = page.getByRole('dialog', { name: 'Sub-agent' });
      // (The run is read on open: a cold route can take a moment.)
      await expect(dialog.getByText(/2 of \d+ model calls/)).toBeVisible({ timeout: 15_000 });
      await expect(dialog.locator('[data-subagent-model]')).toHaveText(`on ${fastModelLabel}`);
      await expect(dialog.getByText('Searching the closed sprint.')).toBeVisible();
      await expect(dialog.getByText(TASK)).toBeVisible();
      await shot('chat-subagent-transcript.png');
      await dialog.getByRole('button', { name: 'Close' }).click();
      await expect(dialog).toHaveCount(0);

      // ── Phone width ──
      await page.setViewportSize({ width: 390, height: 844 });
      await page.reload();
      await expect(main.getByText(QUESTION)).toBeVisible();
      const narrow = main.locator('details[data-subagent]');
      await expect(narrow).toContainText('read-only');
      await expectNoHorizontalOverflow(page);
      await shot('chat-subagent-mobile.png');
    } finally {
      await removeModel(page.request, mainModel);
      await removeModel(page.request, fastModel);
    }
  });
});
