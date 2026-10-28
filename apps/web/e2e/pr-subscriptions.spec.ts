/**
 * A person's own opt-in to a pull request's pipeline outcome: the
 * project page's own condensed row (pr-subscribe.tsx's `compact`
 * layout, on the Pulls card's most-recent PR) and the full Pulls
 * page's per-row disclosure — both backed by the same real POST/DELETE
 * against .../pr-subscriptions (no external host call in that route, so
 * nothing to mock there), and the outcome line of an already-subscribed
 * PR. The project's own `pulls` route is mocked (AGENTS.md: a call that
 * would hit a real vendor is mocked at the browser edge), and so is the
 * one thing only a background process writes: the recorded pipeline
 * outcome (pr_pipeline_events), which the worker's webhook handler
 * (apps/worker/src/handlers/pr-pipeline-events.ts) records after
 * re-reading the run at the code host's own API. The subscription itself
 * is the real one, made through the route; only its `lastEvent` is added
 * to the route's real answer.
 *
 * The project is the test's own person's, on Bitbucket (connected through
 * the real connect flow, e2e/support/code-host.ts).
 */

import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Page, TestInfo } from '@playwright/test';
import { test, expect } from './fixtures';
import {
  connectBitbucket,
  createChat,
  createCodeProject,
  prepareCodeHost,
} from './support/code-host';

const MOBILE_VIEWPORT = { width: 390, height: 844 };

interface Ids {
  projectId: string;
  projectName: string;
  chatTitle: string;
  repoFullName: string;
}

const OPEN_PR = { number: 90 };
const SEEDED_PR = { number: 91 };

function pullRequests(ids: Ids) {
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
      url: `https://bitbucket.org/${ids.repoFullName}/pull-requests/90`,
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
      url: `https://bitbucket.org/${ids.repoFullName}/pull-requests/91`,
    },
  ];
}

/** A project of the person's own, with a chat, and PR #91 already subscribed (auto-merge on). */
async function stage(page: Page, testInfo: TestInfo): Promise<Ids> {
  const tag = `${testInfo.project.name}-${randomUUID().slice(0, 6)}`;
  const ids = {
    projectName: `PR subscriptions project (${tag})`,
    chatTitle: `Land the retry fix (${tag})`,
    repoFullName: `acme/pr-subscriptions-${tag}`,
  };
  const projectId = await createCodeProject(page.request, {
    name: ids.projectName,
    repository: ids.repoFullName,
    branch: 'main',
  });
  await createChat(page.request, { projectId, title: ids.chatTitle });
  const subscribed = await page.request.post(`/api/code/projects/${projectId}/pr-subscriptions`, {
    data: { prNumber: SEEDED_PR.number, watchPipelines: true, autoMerge: true },
  });
  expect(subscribed.ok(), await subscribed.text()).toBe(true);
  return { ...ids, projectId };
}

/**
 * PR #91's recorded outcome — a success, merged automatically — added to
 * the subscription route's real answer, as the webhook worker would have
 * recorded it.
 */
async function mockOutcome(page: Page, ids: Ids): Promise<void> {
  await page.route(`**/api/code/projects/${ids.projectId}/pr-subscriptions?*`, async (route) => {
    const url = new URL(route.request().url());
    if (route.request().method() !== 'GET' || url.searchParams.get('prNumber') !== '91') {
      await route.fallback();
      return;
    }
    // A kept-alive socket the server has just closed resets the first try.
    const response = await route.fetch().catch(() => route.fetch());
    const body: { subscription: unknown } = await response.json();
    await route.fulfill({
      response,
      json: {
        ...body,
        lastEvent: body.subscription
          ? { conclusion: 'success', actionTaken: 'merged', observedAt: new Date().toISOString() }
          : null,
      },
    });
  });
}

async function mockPulls(page: Page, ids: Ids): Promise<void> {
  await page.route(`**/api/code/projects/${ids.projectId}/pulls**`, async (route) => {
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

/** The visible copy of a row's Subscribe disclosure, whichever layout is on screen. */
function subscribeBlock(page: Page, prNumber: number) {
  return page
    .locator('li, tr')
    .filter({ has: page.getByText(`#${prNumber}`, { exact: false }) })
    .filter({ visible: true });
}

test.describe('PR pipeline subscriptions', () => {
  test.beforeEach(async ({ page, request, person: _person }) => {
    await prepareCodeHost(request);
    await connectBitbucket(page);
  });

  test('subscribe, its checkboxes, and a recorded outcome line', async ({ page }, testInfo) => {
    const ids = await stage(page, testInfo);
    // The phone pass runs once, on a resized viewport.
    const mobile = testInfo.project.name === 'desktop-light';
    await mockPulls(page, ids);
    await mockOutcome(page, ids);

    // ── The project page's own condensed row, on the Pulls card's
    // most-recent PR (#90) — no trip to the full Pulls page needed. ──
    await page.goto(`/code/${ids.projectId}`);
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
    await page.goto(`/code/${ids.projectId}/pulls`);
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
      `https://bitbucket.org/${ids.repoFullName}/pull-requests/91`
    );
    await shot(page, testInfo, 'pr-subscribe-outcome.png');

    if (!mobile) return;

    // ── Mobile: the project page's condensed row still works at phone width ──
    await page.goto(`/code/${ids.projectId}`);
    await page.setViewportSize(MOBILE_VIEWPORT);
    const mobilePullsCard = page.getByRole('main').locator('section', {
      has: page.getByRole('heading', { level: 2, name: 'Pull requests' }),
    });
    await expect(mobilePullsCard.getByLabel('Subscribe', { exact: true })).toBeVisible();
    await shot(page, testInfo, 'pr-subscribe-compact-mobile.png');

    // ── Mobile: the full Pulls page's disclosure and outcome line too ──
    await page.goto(`/code/${ids.projectId}/pulls`);
    await page.setViewportSize(MOBILE_VIEWPORT);
    await expect(page.getByRole('heading', { level: 1, name: 'Pull requests' })).toBeVisible();
    const mobileRow91 = subscribeBlock(page, SEEDED_PR.number);
    await mobileRow91.getByText('Subscribe', { exact: true }).click();
    await expect(mobileRow91.getByText('Pipeline succeeded — merged automatically.')).toBeVisible();
    await shot(page, testInfo, 'pr-subscribe-mobile.png');
  });
});
