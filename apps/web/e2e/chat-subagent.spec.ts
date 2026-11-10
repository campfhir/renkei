/**
 * An ordinary chat's sub-agent, run for real — the assistant hands a
 * reading errand to `chat_delegate` (lib/chat/chat-delegate.ts) on another
 * model of the org's, each on a scripted stand-in model
 * (e2e/support/stub-model.ts) — and drawn on the real server: its card
 * unfolds to the report, and its transcript opens from the card with the
 * run as the server kept it. Also a viewport pass at phone width.
 *
 * What the card says — read-only for a chat sub-agent, "on <model>",
 * "Sub-agent reported", the report's first line, the transcript button's
 * words — is message-list.model.test.ts's.
 */

import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures';
import { addStubModel, toolStep, removeModel, scripted } from './support/stub-model';
import { createChat, send } from './support/chat';

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
  test('a plain chat’s sub-agent card unfolds to its report and opens its transcript', async ({
    page,
    person: _person,
  }, testInfo) => {
    const tag = `${testInfo.project.name}-${randomUUID().slice(0, 6)}`;
    const fastModelLabel = `Reading model ${tag}`;
    // The sub-agent's model: its task scripts one search, then the report.
    const fastModel = await addStubModel(page.request, `${tag}-fast`, { label: fastModelLabel });
    const task = scripted(TASK, [
      toolStep(
        'jira_search_issues',
        { jql: 'project = OPS AND sprint in closedSprints() AND status != Done' },
        'Searching the closed sprint.'
      ),
      { text: REPORT },
    ]);
    // The chat's own model: it delegates, then answers from the report.
    const mainModel = await addStubModel(page.request, `${tag}-main`);
    const question = scripted(QUESTION, [
      toolStep(
        'chat_delegate',
        { task, model: fastModelLabel },
        'Let me have the sprint looked through.'
      ),
      {
        text: 'Two issues slipped: OPS-41 with Priya and OPS-44 with Marcus. Both are still open.',
      },
    ]);
    try {
      const chatId = await createChat(page.request, {
        llmModelId: mainModel,
        title: `What slipped out of the OPS sprint? ${tag}`,
      });
      await send(page.request, chatId, question, mainModel);

      const shot = (name: string) =>
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
      const main = page.getByRole('main');
      await page.goto(`/chat/${chatId}`);
      await expect(main.getByText(QUESTION)).toBeVisible();

      // ── The card unfolds to the report ──
      const subagent = main.locator('details[data-subagent]');
      await expect(subagent).toContainText('Sub-agent reported');
      await subagent.locator('> summary').click();
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
      await expect(main.locator('details[data-subagent]')).toBeVisible();
      await expectNoHorizontalOverflow(page);
      await shot('chat-subagent-mobile.png');
    } finally {
      await removeModel(page.request, mainModel);
      await removeModel(page.request, fastModel);
    }
  });
});
