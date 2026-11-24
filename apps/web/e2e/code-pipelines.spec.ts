/**
 * A Bitbucket code project's runs and variables, by branch, in a browser:
 * the project page links to its Environments page (and carries no
 * pipeline card); production's branch's Runs tab draws that branch's
 * runs and the setup on the real server; its Variables tab takes one
 * press through — a `.env` pasted, one row locked, saved: the request
 * reaching the route and the stand-in, the names drawn and the secured
 * value never on the page; the rest of a set-up repository (the switch
 * on, the file committed to the branch, a run started on it) is staged
 * through the routes the page calls and drawn after a reload; then the
 * Runs tab at phone width, the runs as cards; and a code chat's More menu
 * opening the page in a new tab. Bitbucket is the stub in
 * sandbox-stub.mjs (the app is pointed at it with
 * BITBUCKET_API_BASE_URL), which keeps one pipelines row per repository;
 * each test's person makes a project on a repository of its own, so no
 * two tests share state.
 *
 * Where its rules went: the file box, the commit and run requests and
 * when they can be sent, how a run's state and duration read —
 * app/(app)/code/_components/pipelines-page.model.test.ts; the variable
 * rows, the lock and what Save sends — variables-editor.model.test.ts;
 * what the host is asked — lib/code/host-variables.test.ts.
 */

import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { APIResponse, Page, TestInfo } from '@playwright/test';
import { test, expect } from './fixtures';
import {
  assignEnvironments,
  connectBitbucket,
  createChat,
  createCodeProject,
  prepareCodeHost,
} from './support/code-host';

// The catalog's admin page is an operator's.
test.use({ roles: ['renkei-user', 'renkei-operator'] });

const MOBILE_VIEWPORT = { width: 390, height: 844 };

interface Ids {
  tag: string;
  projectId: string;
  name: string;
  repo: string;
}

/**
 * A project on a repository of its own, production deploying from main.
 * The repository must be one the stub's pipelines answer for
 * (`acme/pipelines-demo-*`).
 */
async function stage(page: Page, testInfo: TestInfo): Promise<Ids> {
  const tag = `${testInfo.project.name}-${randomUUID().slice(0, 6)}`;
  const name = `Pipelines demo (${tag})`;
  const repo = `acme/pipelines-demo-${tag}`;
  const projectId = await createCodeProject(page.request, {
    name,
    description: 'Where the pipeline gets set up.',
    repository: repo,
    branch: 'main',
  });
  await assignEnvironments(page.request, projectId);
  return { tag, projectId, name, repo };
}

/**
 * Nothing scrolls sideways — the document, and the frame's own scroll
 * container inside it (a wide table there would not show on the document,
 * but focusing a field beside it would drag the whole page's content off
 * the left edge).
 */
async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => {
    const frame = document.querySelector('main .overflow-y-auto');
    return Math.max(
      document.documentElement.scrollWidth - document.documentElement.clientWidth,
      frame ? frame.scrollWidth - frame.clientWidth : 0
    );
  });
  expect(overflow).toBeLessThanOrEqual(0);
}

test.describe('Code project pipelines', () => {
  let ids: Ids;
  test.beforeEach(async ({ page, request, person: _person }, testInfo) => {
    await prepareCodeHost(request);
    await connectBitbucket(page);
    ids = await stage(page, testInfo);
  });

  test('the project page link, a branch’s Runs tab, variables saved from a pasted .env, a set-up repository drawn, phone width', async ({
    page,
  }, testInfo) => {
    // A dev server compiles each route the first time it is asked for one.
    test.setTimeout(180_000);
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
    const runsPath = `/code/${ids.projectId}/environments?env=production&branch=main&tab=runs`;

    // ── The project page: no pipeline card in the rail, only a link to the
    //    project's Environments page in the repository strip ──
    await page.goto(`/code/${ids.projectId}`);
    await expect(page.getByRole('heading', { level: 1, name: ids.name })).toBeVisible({
      timeout: 30_000,
    });
    const strip = main.getByTestId('code-repo-strip');
    const link = strip.getByRole('link', { name: 'Pipelines', exact: true });
    await expect(link).toHaveAttribute('href', `/code/${ids.projectId}/environments`);
    // The rail is drawn once its Environment card is: no runs, setup or variables beside it.
    await expect(main.getByRole('heading', { level: 2, name: 'Environment' }).first()).toBeVisible({
      timeout: 30_000,
    });
    for (const gone of ['Pipelines', 'Actions', 'Pipeline and deployments', 'Recent runs']) {
      await expect(main.getByRole('heading', { level: 2, name: gone, exact: true })).toHaveCount(0);
    }
    await expectNoHorizontalOverflow(page);
    await shot('code-pipelines-card.png');

    // ── Its Environments page, production's branch, the Runs tab: that
    //    branch's runs and the setup ──
    await link.click();
    await expect(page).toHaveURL(new RegExp(`/code/${ids.projectId}/environments`));
    await main.getByRole('tab', { name: 'Runs' }).click();
    await expect(page).toHaveURL(/env=production&branch=main&tab=runs$/);
    await expect(main.getByRole('link', { name: 'Open on Bitbucket' })).toHaveAttribute(
      'href',
      `https://bitbucket.org/${ids.repo}/pipelines`,
      { timeout: 30_000 }
    );
    const runs = main.getByRole('region', { name: 'Recent runs' });
    const rows = runs.getByRole('row');
    // The branch's own runs: the one on main, not the feature branch's.
    await expect(rows).toHaveCount(2, { timeout: 30_000 });
    await expect(runs.getByRole('list')).toBeHidden();
    await expect(rows.nth(1)).toContainText('#1');
    await expect(rows.nth(1)).toContainText('Successful');
    await expect(rows.nth(1)).toContainText('main');
    await expect(runs).not.toContainText('feature/retry-invoices');
    const setup = main.getByRole('region', { name: 'Setup' });
    await expect(setup.getByText('Off', { exact: true })).toBeVisible();
    await expect(setup.getByText(/Not on main yet\./)).toBeVisible();
    await expect(setup.getByRole('button', { name: 'write one by hand' })).toBeVisible();
    await expectNoHorizontalOverflow(page);
    await shot('code-pipelines-page.png');

    // ── The one press through, on the Variables tab: a .env pasted into
    //    the repository's set, a row locked by hand, saved. The names
    //    appear, the bad line is reported, the secured value is never on
    //    the page again ──
    await main.getByRole('tab', { name: 'Variables' }).click();
    const repository = main.getByTestId('variables-repository');
    const production = main.getByTestId('variables-environment-production');
    await expect(repository.getByText('No variables.')).toBeVisible({ timeout: 30_000 });
    await expect(production.getByText('No variables.')).toBeVisible();
    await repository.getByRole('button', { name: 'Paste .env' }).click();
    await repository
      .getByLabel('.env contents for Repository variables')
      .fill(
        'BUILD_FLAVOR=npm_secret_value_123\nAPI_BASE_URL=https://api.example.test\nthis line is broken\n'
      );
    await repository.getByRole('button', { name: 'Read into rows' }).click();
    await expect(repository.getByText(/Not read as variables: line 3/)).toBeVisible();
    await repository.getByRole('button', { name: 'BUILD_FLAVOR is a secret' }).click();
    await repository.getByRole('button', { name: 'Save' }).click();
    await expect(repository.getByRole('status')).toContainText(
      'Saved: added BUILD_FLAVOR, API_BASE_URL.'
    );
    await expect(repository.getByLabel('Value of BUILD_FLAVOR')).toHaveValue('');
    await expect(
      repository.getByRole('button', { name: 'BUILD_FLAVOR is a secret' })
    ).toHaveAttribute('aria-pressed', 'true');
    await expect(repository.getByLabel('Value of API_BASE_URL')).toHaveValue(
      'https://api.example.test'
    );
    expect(await page.content()).not.toContain('npm_secret_value_123');
    await expectNoHorizontalOverflow(page);
    await shot('code-pipelines-variables.png');

    // ── The rest, staged through the routes the page calls: the switch on,
    //    the file committed to the branch, a run started on it, production's
    //    secured variable ──
    const api = `/api/code/projects/${ids.projectId}/pipelines`;
    const ok = async (response: Promise<APIResponse>) => {
      const answered = await response;
      expect(answered.ok(), await answered.text()).toBe(true);
      return answered;
    };
    await ok(page.request.put(api, { data: { enabled: true } }));
    await ok(
      page.request.put(`${api}/config-file?branch=main`, {
        data: {
          text: 'image: node:22\n\npipelines:\n  default:\n    - step:\n        script:\n          - npm test\n',
          message: 'Add bitbucket-pipelines.yml',
        },
      })
    );
    await ok(
      page.request.post(`${api}/runs`, {
        data: { ref: 'main', refType: 'branch', pattern: 'deploy' },
      })
    );
    await ok(
      page.request.put(`/api/code/projects/${ids.projectId}/variables`, {
        data: {
          scope: 'environment',
          environment: 'production',
          set: [{ key: 'DEPLOY_KEY', value: 'deploy-key-bytes', secured: true }],
          remove: [],
        },
      })
    );

    // ── Drawn after a reload: the stub is the truth, not the page ──
    await page.reload();
    await expect(production.getByLabel('Value of DEPLOY_KEY')).toHaveValue('', {
      timeout: 30_000,
    });
    await expect(repository.getByLabel('Value of DEPLOY_KEY')).toHaveCount(0);
    expect(await page.content()).not.toContain('deploy-key-bytes');
    await main.getByRole('tab', { name: 'Runs' }).click();
    await expect(setup.getByText('On', { exact: true })).toBeVisible({ timeout: 30_000 });
    await expect(setup.getByRole('button', { name: 'Turn off' })).toBeVisible();
    await expect(setup.getByText('On main.')).toBeVisible();
    await expect(setup.getByRole('button', { name: 'Edit file' })).toBeVisible();
    await expect(rows).toHaveCount(3);
    await expect(rows.nth(1)).toContainText('#3');
    await expect(rows.nth(1)).toContainText('Pending');
    await expect(rows.nth(1)).toContainText('E2E Dev');
    await shot('code-pipelines-set.png');

    // ── Phone width: the tab again, one column, the runs as cards
    //    rather than a table, nothing sideways ──
    await page.setViewportSize(MOBILE_VIEWPORT);
    await page.goto(runsPath);
    await expect(runs).toBeVisible({ timeout: 30_000 });
    await expect(runs.getByRole('table')).toBeHidden();
    const runCards = runs.getByRole('listitem');
    await expect(runCards).toHaveCount(2);
    await expect(runCards.nth(0)).toContainText('#3');
    await expect(runCards.nth(1)).toContainText('#1');
    // The run form fits the phone too, and starts on this branch.
    await runs.getByRole('button', { name: 'Run pipeline' }).click();
    await expect(runs.getByRole('form', { name: 'Run pipeline' })).toBeVisible();
    await runs.getByRole('button', { name: 'Cancel' }).click();
    await expectNoHorizontalOverflow(page);
    await shot('code-pipelines-mobile.png');
  });

  test('a code chat’s overflow menu opens the project’s environments in a new tab', async ({
    page,
  }) => {
    const chatId = await createChat(page.request, { projectId: ids.projectId, title: 'Draft CI' });
    await page.goto(`/chat/${chatId}`);
    const main = page.getByRole('main');
    await main.getByRole('button', { name: 'More', exact: true }).click();
    const opened = page.waitForEvent('popup');
    await page.getByRole('menuitem', { name: 'Pipelines', exact: true }).click();
    const tab = await opened;
    await expect(tab).toHaveURL(new RegExp(`/code/${ids.projectId}/environments`));
    const there = tab.getByRole('main');
    await expect(there.getByRole('region', { name: 'production', exact: true })).toBeVisible({
      timeout: 30_000,
    });
    await expect(there.getByRole('tab', { name: 'Variables' })).toBeVisible();
    // The chat stays where it was.
    await expect(page).toHaveURL(new RegExp(`/chat/${chatId}$`));
    await tab.close();
  });
});
