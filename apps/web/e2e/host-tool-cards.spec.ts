/**
 * Git-host calls in a thread, drawn on the real server at desktop and
 * phone width: a plain chat whose pull request folds with the reads, and
 * a chat of a GitHub code project (e2e/support/code-host.ts: the person
 * connected through the fake OAuth, the project cloned on the sandbox
 * stub) where the pull request stands as a card with the host's link. The
 * stand-in model reaches for two host reads, then the pull request; the
 * sandbox stub answers it as GitHub would (#12).
 *
 * Which calls are lifted and which fold is lib/chat/segment.test.ts's;
 * what the fold's line and the card say ("3 tool calls", "Opened a pull
 * request", the headline and link a result gives) is
 * message-list.model.test.ts's. Left here: both pages render the real
 * turn, the card unfolds to the host's link, nothing overflows a phone,
 * and the screenshots.
 */

import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures';
import { removeModel, scripted, toolStep, type StubStep } from './support/stub-model';
import { createChat, send } from './support/chat';
import {
  askAndWait,
  connectCodeHost,
  createCodeProject,
  createChat as createCodeChat,
  setUpCode,
} from './support/code-host';

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

test('host calls render in a plain and a code chat, the pull request card with its link', async ({
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
          'test-results',
          'screens',
          testInfo.project.name,
          name
        ),
        fullPage: false,
      });
    const main = page.getByRole('main');

    // ── The plain chat: the work folds into one line ──
    await page.goto(`/chat/${plainChat}`);
    await expect(main.getByText(PROMPT)).toBeVisible();
    await expect(main.getByText(REPLY)).toBeVisible();
    await expect(main.locator('details.chat-fold').first()).toContainText('3 tool calls');
    await expectNoHorizontalOverflow(page);
    await shot('host-tool-cards-plain.png');

    // ── The code project's chat: the pull request's card unfolds to the
    //    host's link ──
    await page.goto(`/chat/${codeChat}`);
    await expect(main.getByText(REPLY)).toBeVisible();
    const card = main.locator('details[data-milestone="github_create_pull_request"]');
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
    await expect(card).toBeVisible();
    await expectNoHorizontalOverflow(page);
    await shot('host-tool-cards-code-mobile.png');
    await page.goto(`/chat/${plainChat}`);
    await expect(main.getByText(PROMPT)).toBeVisible();
    await expectNoHorizontalOverflow(page);
    await shot('host-tool-cards-plain-mobile.png');
  } finally {
    await removeModel(page.request, modelId);
  }
});
