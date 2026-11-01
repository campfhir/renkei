/**
 * Auto-detected issue cards beside the project screen's active chat, in a
 * browser: a Jira issue and a GitHub issue guessed from that chat's most
 * recent pull request title (lib/code/issue-refs.ts) and fetched live,
 * drawn on the project page and at phone width.
 *
 * The project is the test's own person's, a GitHub one: they connect
 * GitHub through the real connect flow (the in-memory app's fake OAuth,
 * e2e/support/code-host.ts) and create the project and its chat through
 * the routes the UI calls.
 *
 * The cards' data is Jira's and GitHub's, fetched server-side by
 * …/chats/[chatId]/issues (Jira at api.atlassian.com, which has no
 * stand-in), so — as project-pulls-commits.spec.ts does for its
 * GitHub-backed routes — the browser's request to that route is answered
 * with page.route.
 *
 * Where its rules went: nothing shown — and no error — when neither
 * resolves or the lookup fails, Jira first, what a card reads —
 * app/(app)/code/_components/issue-cards.model.test.ts; the real route's
 * empty answer for a branch and chat that name no issue —
 * app/api/code/projects/[projectId]/chats/[chatId]/issues/route.test.ts.
 */

import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Page, TestInfo } from '@playwright/test';
import { test, expect } from './fixtures';
import {
  connectCodeHost,
  createChat,
  createCodeProject,
  prepareCodeHost,
} from './support/code-host';

const MOBILE_VIEWPORT = { width: 390, height: 844 };

interface Ids {
  projectId: string;
  chatId: string;
  projectName: string;
}

/** A GitHub project of the person's own on main, with a chat in it. */
async function stage(page: Page, testInfo: TestInfo): Promise<Ids> {
  const tag = `${testInfo.project.name}-${randomUUID().slice(0, 6)}`;
  const projectName = `Issue cards project (${tag})`;
  const projectId = await createCodeProject(page.request, {
    provider: 'github',
    name: projectName,
    repository: 'acme/site',
    branch: 'main',
  });
  const chatId = await createChat(page.request, {
    projectId,
    title: `Fix the retry loop (${tag})`,
  });
  return { projectId, chatId, projectName };
}

async function shot(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  await page.screenshot({
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

test.describe('issue cards', () => {
  test.beforeEach(async ({ page, request, person: _person }) => {
    await prepareCodeHost(request);
    await connectCodeHost(page, 'github');
  });

  test('renders a Jira card and a GitHub issue card on a match', async ({ page }, testInfo) => {
    const ids = await stage(page, testInfo);
    await page.route(
      `**/api/code/projects/${ids.projectId}/chats/${ids.chatId}/issues`,
      async (route) => {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            jira: {
              key: 'PROJ-9',
              title: 'Retry loop spins forever',
              status: 'In Progress',
              url: 'https://acme.atlassian.net/browse/PROJ-9',
            },
            github: {
              number: 41,
              title: 'Retry loop bug',
              state: 'open',
              url: 'https://github.com/acme/site/issues/41',
            },
          }),
        });
      }
    );

    await page.goto(`/code/${ids.projectId}`);
    await expect(page.getByRole('heading', { level: 1, name: ids.projectName })).toBeVisible();
    const main = page.getByRole('main');
    await expect(main.getByRole('link', { name: /PROJ-9/ })).toBeVisible();
    await expect(main.getByText('In Progress')).toBeVisible();
    await expect(main.getByRole('link', { name: /#41.*open/ })).toBeVisible();
    await shot(page, testInfo, 'issue-cards-both.png');

    // The phone pass, as a resized viewport.
    await page.setViewportSize(MOBILE_VIEWPORT);
    await expect(main.getByRole('link', { name: /PROJ-9/ })).toBeVisible();
    await shot(page, testInfo, 'issue-cards-mobile.png');
  });
});
