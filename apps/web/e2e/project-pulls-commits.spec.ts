/**
 * The project screen's PRs/Commits/Actions cards and pages, and a chat
 * row's "most recent PR" badge — all mocked with page.route (AGENTS.md:
 * a call that would hit a real vendor/provider, GitHub here, is mocked
 * at the browser edge). Since these routes call GitHub server-side, not
 * from the browser, mocking the browser's request to our own
 * `/api/tenant/.../pulls|commits|actions|pr-summary` routes keeps the
 * real GitHub API entirely out of the loop — the server-side call never
 * happens once the browser's own request is intercepted.
 *
 * A GitHub project, to exercise the Actions card path (Bitbucket's
 * richer Pipelines is already covered by code.spec.ts's fixtures).
 *
 * Own tenant fixtures under the shared e2e/seed.ts tenant, with
 * project/chat ids distinct from code.spec.ts's and
 * branch-switcher.spec.ts's own so the specs never collide running
 * side by side.
 */

import path from 'node:path';
import { test, expect, type Page, type TestInfo } from '@playwright/test';
import { Client } from 'pg';
import { E2E_SLUG, E2E_SUBJECT, E2E_TENANT_ID } from './seed';

const MOBILE_VIEWPORT = { width: 390, height: 844 };

test.use({
  browserName: 'chromium',
  launchOptions: {
    executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    args: ['--no-sandbox'],
  },
});

function idsFor(project: string) {
  const digit = { 'desktop-light': '1', 'desktop-dark': '2', mobile: '3' }[project] ?? '4';
  return {
    projectId: `66666666-6666-4666-8666-6666666666${digit}1`,
    chatId: `66666666-6666-4666-8666-6666666666${digit}2`,
    projectName: `Pulls & commits project (${digit})`,
    chatTitle: `Ship the fix (${digit})`,
  };
}

async function db(): Promise<Client> {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  return client;
}

async function seedFixtures(ids: ReturnType<typeof idsFor>): Promise<void> {
  const client = await db();
  try {
    await client.query('DELETE FROM chats WHERE id = $1', [ids.chatId]);
    await client.query('DELETE FROM chat_projects WHERE id = $1', [ids.projectId]);
    await client.query(
      `INSERT INTO chat_projects
         (id, tenant_id, owner_subject, name, kind, repo_provider, repo_full_name, repo_branch)
       VALUES ($1, $2, $3, $4, 'code', 'github', 'acme/site', 'main')`,
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

async function cleanFixtures(ids: ReturnType<typeof idsFor>): Promise<void> {
  const client = await db();
  try {
    await client.query('DELETE FROM chats WHERE id = $1', [ids.chatId]);
    await client.query('DELETE FROM chat_projects WHERE id = $1', [ids.projectId]);
  } finally {
    await client.end();
  }
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

async function mockRoutes(page: Page, ids: ReturnType<typeof idsFor>): Promise<void> {
  await page.route(`**/api/tenant/**/code/projects/${ids.projectId}/pulls**`, async (route) => {
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
          { ...MOST_RECENT_PR, number: 41, title: 'Earlier fix', url: 'https://github.com/acme/site/pull/41' },
        ],
        hasMore: false,
      }),
    });
  });

  await page.route(`**/api/tenant/**/code/projects/${ids.projectId}/commits**`, async (route) => {
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

  await page.route(`**/api/tenant/**/code/projects/${ids.projectId}/actions**`, async (route) => {
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

  await page.route(`**/api/tenant/**/chat/chats/${ids.chatId}/pr-summary`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        pullRequest: { number: 42, title: 'Fix the timeout', state: 'open', host: 'github', url: MOST_RECENT_PR.url },
      }),
    });
  });
}

async function shot(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  await page.screenshot({
    path: path.join(import.meta.dirname, '..', 'test-results', 'screens', testInfo.project.name, name),
    fullPage: false,
  });
}

test.describe('project pulls, commits and actions', () => {
  // eslint-disable-next-line no-empty-pattern
  test.beforeEach(async ({}, testInfo) => {
    await seedFixtures(idsFor(testInfo.project.name));
  });
  // eslint-disable-next-line no-empty-pattern
  test.afterEach(async ({}, testInfo) => {
    await cleanFixtures(idsFor(testInfo.project.name));
  });

  test('cards on the project screen, a chat row PR badge, and the full pages', async ({
    page,
  }, testInfo) => {
    const ids = idsFor(testInfo.project.name);
    const mobile = testInfo.project.name === 'mobile';
    await mockRoutes(page, ids);
    const main = page.getByRole('main');

    // ── The project screen: Pulls, Commits and Actions cards ──
    await page.goto(`/${E2E_SLUG}/code/${ids.projectId}`);
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
    await page.goto(`/${E2E_SLUG}/code/${ids.projectId}/commits`);
    await expect(page.getByRole('heading', { level: 1, name: 'Commits' })).toBeVisible();
    await expect(page.getByText('Fix the timeout')).toBeVisible();
    const loadMore = page.getByRole('button', { name: 'Load more' });
    await expect(loadMore).toBeVisible();
    await loadMore.click();
    await expect(loadMore).toHaveCount(0);
    await shot(page, testInfo, 'project-commits-page.png');

    if (!mobile) return;

    // ── Mobile: the cards still render at phone width ──
    await page.goto(`/${E2E_SLUG}/code/${ids.projectId}`);
    await page.setViewportSize(MOBILE_VIEWPORT);
    await expect(page.getByRole('heading', { level: 1, name: ids.projectName })).toBeVisible();
    await expect(page.getByText('#42 Fix the timeout')).toBeVisible();
    await shot(page, testInfo, 'project-pulls-commits-mobile.png');
  });
});
