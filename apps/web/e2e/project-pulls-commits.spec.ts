/**
 * The project screen's PRs/Commits/Actions cards and pages, and a chat
 * row's "most recent PR" badge — all mocked with page.route (AGENTS.md:
 * a call that would hit a real vendor/provider, GitHub here, is mocked
 * at the browser edge). Since these routes call GitHub server-side, not
 * from the browser, mocking the browser's request to our own
 * `/api/pulls|commits|actions|pr-summary` routes keeps the
 * real GitHub API entirely out of the loop — the server-side call never
 * happens once the browser's own request is intercepted.
 *
 * A GitHub project, to exercise the Actions card path (Bitbucket's
 * richer Pipelines is already covered by code.spec.ts's fixtures).
 *
 * The project is the test's own person's, who connects GitHub through the
 * real connect flow (e2e/support/code-host.ts: the in-memory app's fake
 * OAuth answers the consent, the exchange and the identity read). The no-access case is
 * the same kind of project shared with a second person who never
 * connected GitHub: the host's real reason reaching each card on the real
 * server. The phone pass runs in desktop-light only (the spec is in
 * DARK_SPECS for that reason).
 *
 * Where its rules went: the count pill, the state pills, which rows offer
 * a subscription, the badge's tone, how far Load more asks and when it
 * goes, what a failed read leaves on screen —
 * app/(app)/code/_components/{pulls-summary,pulls-page,chat-pr-badge,
 * commits-page}.model.test.ts; what the pulls and commits routes ask the
 * host for and how they pass its reason on —
 * app/api/code/projects/[projectId]/{pulls,commits}/route.test.ts.
 */

import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Page, TestInfo } from '@playwright/test';
import { test, expect } from './fixtures';
import { createPerson, signIn } from './support/person';
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
  chatTitle: string;
}

/** A GitHub project of the person's own, with a chat in it. */
async function stage(page: Page, testInfo: TestInfo, repository: string): Promise<Ids> {
  const tag = `${testInfo.project.name}-${randomUUID().slice(0, 6)}`;
  const projectName = `Pulls & commits project (${tag})`;
  const chatTitle = `Ship the fix (${tag})`;
  const projectId = await createCodeProject(page.request, {
    provider: 'github',
    name: projectName,
    repository,
    branch: 'main',
  });
  const chatId = await createChat(page.request, { projectId, title: chatTitle });
  return { projectId, chatId, projectName, chatTitle };
}

const MOST_RECENT_PR = {
  number: 42,
  title: 'Fix the timeout',
  state: 'open',
  draft: false,
  sourceBranch: 'feat/timeout-fix',
  destinationBranch: 'main',
  author: 'octocat',
  updatedAt: '2026-09-01T00:00:00.000Z',
  url: 'https://github.com/acme/site/pull/42',
};

const MOST_RECENT_COMMIT = {
  sha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  message: 'Fix the timeout',
  author: 'octocat',
  date: '2026-09-01T00:00:00.000Z',
  url: 'https://github.com/acme/site/commit/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
};

const LAST_RUN = {
  id: '999',
  state: 'success',
  ref: 'main',
  url: 'https://github.com/acme/site/actions/runs/999',
  startedAt: '2026-09-01T00:00:00.000Z',
};

async function mockRoutes(page: Page, ids: Ids): Promise<void> {
  await page.route(`**/api/code/projects/${ids.projectId}/pulls**`, async (route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.get('view') === 'summary') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ openCount: 2, hasMore: false, mostRecent: MOST_RECENT_PR }),
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        pullRequests: [
          MOST_RECENT_PR,
          {
            ...MOST_RECENT_PR,
            number: 41,
            title: 'Earlier fix',
            url: 'https://github.com/acme/site/pull/41',
          },
        ],
        hasMore: false,
      }),
    });
  });

  await page.route(`**/api/code/projects/${ids.projectId}/commits**`, async (route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.get('view') === 'summary') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ mostRecent: MOST_RECENT_COMMIT }),
      });
      return;
    }
    const max = Number(url.searchParams.get('max') ?? '30');
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        commits: [MOST_RECENT_COMMIT],
        hasMore: max < 60,
      }),
    });
  });

  await page.route(`**/api/code/projects/${ids.projectId}/actions**`, async (route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.get('view') === 'summary') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ lastRun: LAST_RUN }),
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ runs: [LAST_RUN] }),
    });
  });

  await page.route(`**/api/chat/chats/${ids.chatId}/pr-summary`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        pullRequest: {
          number: 42,
          title: 'Fix the timeout',
          state: 'open',
          host: 'github',
          url: MOST_RECENT_PR.url,
        },
      }),
    });
  });
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

test.describe('project pulls, commits and actions', () => {
  test.beforeEach(async ({ page, request, person: _person }) => {
    await prepareCodeHost(request);
    await connectCodeHost(page, 'github');
  });

  test('cards on the project screen, a chat row PR badge, and the full pages', async ({
    page,
  }, testInfo) => {
    const ids = await stage(page, testInfo, 'acme/site');
    // The phone pass runs once, on a resized viewport.
    const mobile = testInfo.project.name === 'desktop-light';
    await mockRoutes(page, ids);
    const main = page.getByRole('main');

    // ── The project screen: Pulls, Commits and Actions cards ──
    await page.goto(`/code/${ids.projectId}`);
    await expect(page.getByRole('heading', { level: 1, name: ids.projectName })).toBeVisible();

    const pulls = main.locator('section', {
      has: page.getByRole('heading', { level: 2, name: 'Pull requests' }),
    });
    await expect(pulls.getByText('#42 Fix the timeout')).toBeVisible();
    await expect(pulls.getByText('2 open')).toBeVisible();

    const commits = main.locator('section', {
      has: page.getByRole('heading', { level: 2, name: 'Commits' }),
    });
    await expect(commits.getByText('aaaaaaaaaaaa')).toBeVisible();

    const actions = main.locator('section', {
      has: page.getByRole('heading', { level: 2, name: 'Actions' }),
    });
    await expect(actions.getByText('Success')).toBeVisible();
    await shot(page, testInfo, 'project-pulls-commits-cards.png');

    // ── The active chat row: its most recent PR, as a badge ──
    const chatRow = main.getByRole('link', { name: ids.chatTitle });
    await expect(chatRow.getByTestId('chat-pr-badge')).toHaveText('#42');

    // ── The full Pulls page ──
    await pulls.getByRole('link', { name: 'See all' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Pull requests' })).toBeVisible();
    // Both the mobile-card list and the desktop table render every row;
    // only one is actually on screen at a given viewport (sm:hidden /
    // hidden sm:table), so pick the one Playwright says is visible.
    await expect(page.locator('text=#41 Earlier fix >> visible=true')).toBeVisible();
    await shot(page, testInfo, 'project-pulls-page.png');

    // ── The full Commits page, with Load more ──
    await page.goto(`/code/${ids.projectId}/commits`);
    await expect(page.getByRole('heading', { level: 1, name: 'Commits' })).toBeVisible();
    await expect(page.getByText('Fix the timeout')).toBeVisible();
    const loadMore = page.getByRole('button', { name: 'Load more' });
    await expect(loadMore).toBeVisible();
    // The one press through: Load more asks for a page more, and the
    // answer's hasMore takes the button away.
    const wider = page.waitForRequest((request) =>
      request.url().includes(`/api/code/projects/${ids.projectId}/commits?max=60`)
    );
    await loadMore.click();
    await wider;
    await expect(loadMore).toHaveCount(0);
    await shot(page, testInfo, 'project-commits-page.png');

    if (!mobile) return;

    // ── Mobile: the cards still render at phone width ──
    await page.goto(`/code/${ids.projectId}`);
    await page.setViewportSize(MOBILE_VIEWPORT);
    await expect(page.getByRole('heading', { level: 1, name: ids.projectName })).toBeVisible();
    await expect(page.getByText('#42 Fix the timeout')).toBeVisible();
    await shot(page, testInfo, 'project-pulls-commits-mobile.png');
  });

  test('the cards stay visible with the actual reason, not hidden, on no GitHub access', async ({
    page,
    browser,
    request,
  }, testInfo) => {
    // The project is shared with someone who never connected GitHub: the
    // cards read the repository with the VIEWER's own grant, which is not
    // there, so nothing reaches GitHub at all.
    const ids = await stage(page, testInfo, 'acme/no-access-repo');
    const viewer = await createPerson(request, { displayName: 'No GitHub viewer' });
    const shared = await page.request.post(`/api/chat/projects/${ids.projectId}/grants`, {
      data: { granteeSubject: viewer.subject, role: 'viewer' },
    });
    expect(shared.ok(), await shared.text()).toBe(true);
    const context = await browser.newContext({ reducedMotion: 'reduce' });
    await signIn(context, viewer);
    const viewerPage = await context.newPage();
    try {
      const main = viewerPage.getByRole('main');
      await viewerPage.goto(`/code/${ids.projectId}`);
      await expect(
        viewerPage.getByRole('heading', { level: 1, name: ids.projectName })
      ).toBeVisible();

      const pulls = main.locator('section', {
        has: viewerPage.getByRole('heading', { level: 2, name: 'Pull requests' }),
      });
      const commits = main.locator('section', {
        has: viewerPage.getByRole('heading', { level: 2, name: 'Commits' }),
      });
      const actions = main.locator('section', {
        has: viewerPage.getByRole('heading', { level: 2, name: 'Actions' }),
      });
      // The cards stay on the page — not hidden entirely — and each
      // names the actual reason a person can act on.
      await expect(pulls.getByRole('alert')).toContainText('GitHub is not connected');
      await expect(commits.getByRole('alert')).toContainText('GitHub is not connected');
      await expect(actions.getByRole('alert')).toContainText('GitHub is not connected');
      await shot(viewerPage, testInfo, 'project-pulls-commits-no-access.png');
    } finally {
      await context.close();
    }
  });
});
