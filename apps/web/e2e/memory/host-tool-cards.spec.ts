/**
 * Which git-host calls stand out in a thread. A reply's tool calls fold
 * into one collapsed line; in a code project's chat the calls a person
 * waits on — a pull request opened or merged, a commit, a branch — are
 * lifted out as cards of their own (lib/code/milestones.ts), while reading
 * a file or listing branches fold with the rest. In an ordinary chat
 * nothing is lifted: a word to GitHub or Bitbucket is a tool call like any
 * other.
 *
 * The same turn really runs twice — in a plain chat, and in a chat of a
 * GitHub code project (e2e/support/code-host.ts: the person connected
 * through the fake OAuth, the project cloned on the sandbox stub) — the
 * stand-in model reaching for two host reads and then the pull request.
 * The sandbox stub answers the pull request as GitHub would (#12); the
 * reads find nothing there, which still folds as a call. Also a viewport
 * pass at phone width.
 */

import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures';
import { removeModel, scripted, toolStep, type StubStep } from '../support/stub-model';
import { createChat, send } from '../support/chat';
import {
  askAndWait,
  connectCodeHost,
  createCodeProject,
  createChat as createCodeChat,
  setUpCode,
} from '../support/code-host';

// Adding a model and the code hosts is an operator's.
test.use({ roles: ['renkei-user', 'renkei-operator'] });

const PROMPT = 'Open a pull request for the timeout fix on acme/demo.';
const REPLY = 'Pull request #12 is open against main.';
/** Two host reads, then the pull request. */
const PULL_REQUEST: StubStep[] = [
  {
    tools: [
      { name: 'github_list_branches', input: { owner: 'acme', repo: 'demo' } },
      {
        name: 'github_read_file',
        input: { owner: 'acme', repo: 'demo', path: 'src/timeout.ts', ref: 'fix/timeout' },
      },
    ],
  },
  toolStep('github_create_pull_request', {
    owner: 'acme',
    repo: 'demo',
    title: 'Fix the timeout',
    sourceBranch: 'fix/timeout',
    destinationBranch: 'main',
  }),
  { text: REPLY },
];

async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth
  );
  expect(overflow).toBeLessThanOrEqual(0);
}

test('a plain chat folds every host call; a code chat lifts the pull request alone', async ({
  page,
  request,
  person: _person,
}, testInfo) => {
  test.slow();
  const tag = `${testInfo.project.name}-${randomUUID().slice(0, 6)}`;
  const modelId = await setUpCode(page, request, tag);
  await connectCodeHost(page, 'github');
  try {
    const plainChat = await createChat(page.request, {
      llmModelId: modelId,
      title: `Open a pull request for the timeout fix ${tag}`,
    });
    await send(page.request, plainChat, scripted(PROMPT, PULL_REQUEST), modelId, { allow: true });

    const projectId = await createCodeProject(page.request, {
      provider: 'github',
      name: `Demo service (host cards ${tag})`,
      repository: 'acme/demo',
      branch: 'main',
      description: 'The demo service.',
    });
    const codeChat = await createCodeChat(page.request, {
      projectId,
      title: `Open a pull request for the timeout fix (code, ${tag})`,
      llmModelId: modelId,
    });
    // The first turn clones the repository; the pull request is the second.
    await askAndWait(page.request, codeChat, { text: 'Clone it, please.', llmModelId: modelId });
    await askAndWait(page.request, codeChat, {
      text: scripted(PROMPT, PULL_REQUEST),
      llmModelId: modelId,
    });

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

    // ── The plain chat: no card at all — the pull request folds with the
    //    reads, three steps under one line ──
    await page.goto(`/chat/${plainChat}`);
    await expect(main.getByText(PROMPT)).toBeVisible();
    await expect(main.getByText(REPLY)).toBeVisible();
    await expect(main.locator('details[data-milestone]')).toHaveCount(0);
    const plainWork = main.locator('details.chat-fold').first();
    await expect(plainWork).toContainText('3 tool calls');
    await plainWork.locator('> summary').click();
    await expect(plainWork.locator('ol > li > details.chat-fold')).toHaveCount(3);
    await expectNoHorizontalOverflow(page);
    await shot('host-tool-cards-plain.png');

    // ── The code project's chat: the two reads are steps inside the one
    //    folded line, and the pull request stands on its own with the
    //    host's link ──
    await page.goto(`/chat/${codeChat}`);
    await expect(main.getByText(PROMPT)).toBeVisible();
    await expect(main.getByText(REPLY)).toBeVisible();
    await expect(main.locator('details[data-milestone="github_list_branches"]')).toHaveCount(0);
    await expect(main.locator('details[data-milestone="github_read_file"]')).toHaveCount(0);
    // (The first turn's clone folds in a line of its own, above.)
    const work = main
      .locator('details.chat-fold:not([data-milestone])', { hasText: '2 tool calls' })
      .first();
    await expect(work).toBeVisible();
    await work.locator('> summary').click();
    await expect(work.locator('ol > li > details.chat-fold')).toHaveCount(2);
    const card = main.locator('details[data-milestone="github_create_pull_request"]');
    await expect(card).toHaveCount(1);
    await expect(card).toContainText('Created pull request #12');
    await card.locator('> summary').click();
    await expect(card.getByRole('link', { name: 'Open on GitHub' })).toHaveAttribute(
      'href',
      'https://github.com/acme/demo/pull/12'
    );
    await expectNoHorizontalOverflow(page);
    await shot('host-tool-cards-code.png');

    // ── Phone width, both ──
    await page.setViewportSize({ width: 390, height: 844 });
    await page.reload();
    await expect(main.getByText(PROMPT)).toBeVisible();
    await expect(main.locator('details[data-milestone]')).toHaveCount(1);
    await expectNoHorizontalOverflow(page);
    await shot('host-tool-cards-code-mobile.png');
    await page.goto(`/chat/${plainChat}`);
    await expect(main.getByText(PROMPT)).toBeVisible();
    await expect(main.locator('details[data-milestone]')).toHaveCount(0);
    await expectNoHorizontalOverflow(page);
    await shot('host-tool-cards-plain-mobile.png');
  } finally {
    await removeModel(page.request, modelId);
  }
});
