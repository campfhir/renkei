/**
 * Which git-host calls stand out in a thread. A reply's tool calls fold
 * into one collapsed line; in a code project's chat the calls a person
 * waits on — a pull request opened or merged, a commit, a branch — are
 * lifted out as cards of their own (lib/code/milestones.ts). In an
 * ordinary chat nothing is lifted: a word to GitHub or Bitbucket is a tool
 * call like any other, which is what this spec drives — the turn really
 * runs, the scripted stand-in model (e2e/support/stub-model.ts) reaching
 * for two host reads and then the pull request, and every one of them
 * folds into the reply's one line. Also a viewport pass at phone width.
 *
 * The code project's half (the pull request lifted as a card with the
 * host's link) is not here: a code project is created only against the
 * person's own GitHub or Bitbucket grant (POST /api/code/projects), which
 * only an OAuth connection makes, and the host's "Created pull request"
 * answer only a real host gives. lib/code/milestones.ts's unit tests cover
 * which calls are lifted.
 */

import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures';
import { addStubModel, removeModel } from '../support/stub-model';
import { createChat, send } from '../support/chat';

// Adding a model to the roster is an operator's.
test.use({ roles: ['renkei-user', 'renkei-operator'] });

const PROMPT = 'Open a pull request for the timeout fix on acme/demo.';

async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth
  );
  expect(overflow).toBeLessThanOrEqual(0);
}

test.describe('git-host tool cards in an ordinary chat', () => {
  test('a plain chat folds every host call, the pull request with the reads', async ({
    page,
    person: _person,
  }, testInfo) => {
    const tag = `${testInfo.project.name}-${randomUUID().slice(0, 6)}`;
    const modelId = await addStubModel(page.request, tag, {
      script: [
        {
          when: PROMPT,
          steps: [
            {
              tools: [
                { name: 'github_list_branches', input: { owner: 'acme', repo: 'demo' } },
                {
                  name: 'github_read_file',
                  input: { owner: 'acme', repo: 'demo', path: 'src/timeout.ts', ref: 'fix/timeout' },
                },
              ],
            },
            {
              tools: [
                {
                  name: 'github_create_pull_request',
                  input: {
                    owner: 'acme',
                    repo: 'demo',
                    title: 'Fix the timeout',
                    head: 'fix/timeout',
                    base: 'main',
                  },
                },
              ],
            },
            { text: 'Pull request #12 is open against main.' },
          ],
        },
      ],
    });
    try {
      const chatId = await createChat(page.request, {
        llmModelId: modelId,
        title: `Open a pull request for the timeout fix ${tag}`,
      });
      await send(page.request, chatId, PROMPT, modelId, { allow: true });

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

      // No card at all — the pull request folds with the reads, three
      // steps under one line.
      await page.goto(`/chat/${chatId}`);
      await expect(main.getByText(PROMPT)).toBeVisible();
      await expect(main.getByText('Pull request #12 is open against main.')).toBeVisible();
      await expect(main.locator('details[data-milestone]')).toHaveCount(0);
      const plainWork = main.locator('details.chat-fold').first();
      await expect(plainWork).toContainText('3 tool calls');
      await plainWork.locator('> summary').click();
      await expect(plainWork.locator('ol > li > details.chat-fold')).toHaveCount(3);
      await expectNoHorizontalOverflow(page);
      await shot('host-tool-cards-plain.png');

      // Phone width.
      await page.setViewportSize({ width: 390, height: 844 });
      await page.reload();
      await expect(main.getByText(PROMPT)).toBeVisible();
      await expect(main.locator('details[data-milestone]')).toHaveCount(0);
      await expectNoHorizontalOverflow(page);
      await shot('host-tool-cards-plain-mobile.png');
    } finally {
      await removeModel(page.request, modelId);
    }
  });
});
