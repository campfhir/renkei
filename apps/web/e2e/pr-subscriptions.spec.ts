/**
 * A person's own opt-in to a pull request's pipeline outcome: the
 * project page's own condensed row (pr-subscribe.tsx's `compact`
 * layout, on the Pulls card's most-recent PR) and the full Pulls
 * page's per-row disclosure — both backed by the same real POST/DELETE
 * against .../pr-subscriptions (no external host call in that route, so
 * nothing to mock there), and the outcome line rendering from a seeded
 * pr_pipeline_events row. Only the project's own `pulls` route is mocked
 * (AGENTS.md: a call that would hit a real vendor — GitHub here — is
 * mocked at the browser edge).
 *
 * Own tenant fixtures under the shared e2e/seed.ts tenant, with
 * project/chat/pr-subscription ids distinct from the other Code specs so
 * they never collide running side by side.
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
    projectId: `77777777-7777-4777-8777-7777777777${digit}1`,
    chatId: `77777777-7777-4777-8777-7777777777${digit}2`,
    subscriptionId: `77777777-7777-4777-8777-7777777777${digit}3`,
    projectName: `PR subscriptions project (${digit})`,
    chatTitle: `Land the retry fix (${digit})`,
    // pr_subscriptions' unique index is (tenant, provider, repo, pr, subscriber)
    // with no project_id — a repo name shared across projects would collide
    // when the three Playwright projects subscribe to "the same" PR concurrently.
    repoFullName: `acme/pr-subscriptions-${digit}`,
  };
}

const OPEN_PR = { number: 90 };
const SEEDED_PR = { number: 91 };

function pullRequests(ids: ReturnType<typeof idsFor>) {
  return [
    {
      number: OPEN_PR.number,
      title: 'No opt-in yet',
      state: 'open',
      draft: false,
      sourceBranch: 'feat/no-optin',
      destinationBranch: 'main',
      author: 'octocat',
      updatedAt: '2026-09-01T00:00:00.000Z',
      url: `https://github.com/${ids.repoFullName}/pull/90`,
    },
    {
      number: SEEDED_PR.number,
      title: 'Already subscribed fix',
      state: 'open',
      draft: false,
      sourceBranch: 'feat/seeded',
      destinationBranch: 'main',
      author: 'octocat',
      updatedAt: '2026-09-01T00:00:00.000Z',
      url: `https://github.com/${ids.repoFullName}/pull/91`,
    },
  ];
}

async function db(): Promise<Client> {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  return client;
}

async function seedFixtures(ids: ReturnType<typeof idsFor>): Promise<void> {
  const client = await db();
  try {
    await client.query('DELETE FROM pr_pipeline_events WHERE subscription_id = $1', [
      ids.subscriptionId,
    ]);
    await client.query('DELETE FROM pr_subscriptions WHERE project_id = $1', [ids.projectId]);
    await client.query('DELETE FROM chats WHERE id = $1', [ids.chatId]);
    await client.query('DELETE FROM chat_projects WHERE id = $1', [ids.projectId]);
    await client.query(
      `INSERT INTO chat_projects
         (id, tenant_id, owner_subject, name, kind, repo_provider, repo_full_name, repo_branch)
       VALUES ($1, $2, $3, $4, 'code', 'github', $5, 'main')`,
      [ids.projectId, E2E_TENANT_ID, E2E_SUBJECT, ids.projectName, ids.repoFullName]
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

    // PR #91 arrives already subscribed, with a recorded outcome — the
    // "seeded pr_pipeline_events row via direct DB insert" the plan calls
    // for, so the outcome line is asserted against the real GET route
    // rather than a mocked one.
    await client.query(
      `INSERT INTO pr_subscriptions
         (id, tenant_id, project_id, chat_id, subscriber_subject, provider,
          repo_full_name, pr_number, watch_pipelines, auto_fix, auto_merge, status)
       VALUES ($1, $2, $3, $4, $5, 'github', $6, $7, true, false, true, 'active')`,
      [
        ids.subscriptionId,
        E2E_TENANT_ID,
        ids.projectId,
        ids.chatId,
        E2E_SUBJECT,
        ids.repoFullName,
        SEEDED_PR.number,
      ]
    );
    await client.query(
      `INSERT INTO pr_pipeline_events
         (subscription_id, provider_run_id, conclusion, raw_payload, action_taken)
       VALUES ($1, 'run-1', 'success', '{}'::jsonb, 'merged')`,
      [ids.subscriptionId]
    );
  } finally {
    await client.end();
  }
}

async function cleanFixtures(ids: ReturnType<typeof idsFor>): Promise<void> {
  const client = await db();
  try {
    await client.query('DELETE FROM pr_pipeline_events WHERE subscription_id = $1', [
      ids.subscriptionId,
    ]);
    await client.query('DELETE FROM pr_subscriptions WHERE project_id = $1', [ids.projectId]);
    await client.query('DELETE FROM chats WHERE id = $1', [ids.chatId]);
    await client.query('DELETE FROM chat_projects WHERE id = $1', [ids.projectId]);
  } finally {
    await client.end();
  }
}

async function mockPulls(page: Page, ids: ReturnType<typeof idsFor>): Promise<void> {
  await page.route(`**/api/tenant/**/code/projects/${ids.projectId}/pulls**`, async (route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.get('view') === 'summary') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          openCount: 2,
          hasMore: false,
          mostRecent: pullRequests(ids)[0],
        }),
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ pullRequests: pullRequests(ids), hasMore: false }),
    });
  });
}

async function shot(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  await page.screenshot({
    path: path.join(import.meta.dirname, '..', 'test-results', 'screens', testInfo.project.name, name),
    fullPage: false,
  });
}

/** The visible copy of a row's Subscribe disclosure, whichever layout is on screen. */
function subscribeBlock(page: Page, prNumber: number) {
  return page
    .locator('li, tr')
    .filter({ has: page.getByText(`#${prNumber}`, { exact: false }) })
    .filter({ visible: true });
}

test.describe('PR pipeline subscriptions', () => {
  // eslint-disable-next-line no-empty-pattern
  test.beforeEach(async ({}, testInfo) => {
    await seedFixtures(idsFor(testInfo.project.name));
  });
  // eslint-disable-next-line no-empty-pattern
  test.afterEach(async ({}, testInfo) => {
    await cleanFixtures(idsFor(testInfo.project.name));
  });

  test('subscribe, its checkboxes, and a seeded outcome line', async ({ page }, testInfo) => {
    const ids = idsFor(testInfo.project.name);
    const mobile = testInfo.project.name === 'mobile';
    await mockPulls(page, ids);

    // ── The project page's own condensed row, on the Pulls card's
    // most-recent PR (#90) — no trip to the full Pulls page needed. ──
    await page.goto(`/${E2E_SLUG}/code/${ids.projectId}`);
    const main = page.getByRole('main');
    const pullsCard = main.locator('section', {
      has: page.getByRole('heading', { level: 2, name: 'Pull requests' }),
    });
    await expect(pullsCard.getByText(`#${OPEN_PR.number} No opt-in yet`)).toBeVisible();
    const subscribeCompact = pullsCard.getByLabel('Subscribe', { exact: true });
    const fixCompact = pullsCard.getByLabel('Fix', { exact: true });
    const mergeCompact = pullsCard.getByLabel('Merge', { exact: true });
    await expect(subscribeCompact).not.toBeChecked();
    await expect(fixCompact).toBeDisabled();
    await expect(mergeCompact).toBeDisabled();

    await subscribeCompact.check();
    await expect(fixCompact).toBeEnabled();
    await expect(mergeCompact).toBeEnabled();
    await fixCompact.check();
    await shot(page, testInfo, 'pr-subscribe-compact.png');

    // ── The full Pulls page reports the same subscription back — one
    // opt-in, read from either place. ──
    await page.goto(`/${E2E_SLUG}/code/${ids.projectId}/pulls`);
    await expect(page.getByRole('heading', { level: 1, name: 'Pull requests' })).toBeVisible();
    const row90 = subscribeBlock(page, OPEN_PR.number);
    await row90.getByText('Subscribe', { exact: true }).click();
    await expect(row90.getByLabel('Subscribe to pipeline outcomes')).toBeChecked();
    await expect(row90.getByLabel('Note a failure in this chat')).toBeChecked();
    await expect(row90.getByLabel('Merge automatically on success')).not.toBeChecked();
    await shot(page, testInfo, 'pr-subscribe-checked.png');

    // Unsubscribing clears the auto-fix/auto-merge state too.
    await row90.getByLabel('Subscribe to pipeline outcomes').uncheck();
    await expect(row90.getByLabel('Note a failure in this chat')).toBeDisabled();

    // ── PR #91: already subscribed, with a recorded outcome ──
    const row91 = subscribeBlock(page, SEEDED_PR.number);
    await row91.getByText('Subscribe', { exact: true }).click();
    await expect(row91.getByLabel('Subscribe to pipeline outcomes')).toBeChecked();
    await expect(row91.getByLabel('Merge automatically on success')).toBeChecked();
    await expect(row91.getByText('Pipeline succeeded — merged automatically.')).toBeVisible();
    await expect(row91.getByRole('link', { name: 'View' })).toHaveAttribute(
      'href',
      `https://github.com/${ids.repoFullName}/pull/91`
    );
    await shot(page, testInfo, 'pr-subscribe-outcome.png');

    if (!mobile) return;

    // ── Mobile: the project page's condensed row still works at phone width ──
    await page.goto(`/${E2E_SLUG}/code/${ids.projectId}`);
    await page.setViewportSize(MOBILE_VIEWPORT);
    const mobilePullsCard = page.getByRole('main').locator('section', {
      has: page.getByRole('heading', { level: 2, name: 'Pull requests' }),
    });
    await expect(mobilePullsCard.getByLabel('Subscribe', { exact: true })).toBeVisible();
    await shot(page, testInfo, 'pr-subscribe-compact-mobile.png');

    // ── Mobile: the full Pulls page's disclosure and outcome line too ──
    await page.goto(`/${E2E_SLUG}/code/${ids.projectId}/pulls`);
    await page.setViewportSize(MOBILE_VIEWPORT);
    await expect(page.getByRole('heading', { level: 1, name: 'Pull requests' })).toBeVisible();
    const mobileRow91 = subscribeBlock(page, SEEDED_PR.number);
    await mobileRow91.getByText('Subscribe', { exact: true }).click();
    await expect(mobileRow91.getByText('Pipeline succeeded — merged automatically.')).toBeVisible();
    await shot(page, testInfo, 'pr-subscribe-mobile.png');
  });
});
