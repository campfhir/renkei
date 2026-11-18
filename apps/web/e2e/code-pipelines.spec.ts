/**
 * A Bitbucket code project's Pipelines, in a browser: the card on the
 * project page opening its app under Deployments, whose Runs & variables
 * tab renders the recent runs, the setup and the empty
 * variable sets on the real server; one press through — a secured and a
 * plain repository variable saved from the text box, the request reaching
 * the route and the stand-in, the names drawn and the secured value never
 * on the page; the rest of a set-up repository (the switch on, the file
 * committed, a run started, an environment's variable) staged through the
 * routes the page calls and drawn after a reload; then the tab at phone
 * width, the runs as cards; and a code chat's More menu opening it in a
 * new tab. Bitbucket is the
 * stub in sandbox-stub.mjs (the app is pointed at it with
 * BITBUCKET_API_BASE_URL), which keeps one pipelines row per repository;
 * each test's person makes a project on a repository of its own
 * (connected through the real connect flow, with the admin and
 * pipeline-variable scopes the page stands on: e2e/support/code-host.ts),
 * so no two tests share state.
 *
 * Where its rules went: the file box, the commit and run requests and when they can be sent, which variables a save
 * takes away and the question it asks, the words under a saved set, how a
 * run's state and duration read — app/(app)/deployments/_components/
 * pipelines-page.model.test.ts.
 */

import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { APIResponse, Page, TestInfo } from '@playwright/test';
import { test, expect } from './fixtures';
import {
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
 * The person's Bitbucket connection, and a
 * project on a repository of its own. The repository must be one the
 * stub's pipelines answer for (`acme/pipelines-demo-*`).
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

  test('card, page, a variable set saved, a set-up repository drawn, phone width', async ({
    page,
  }, testInfo) => {
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
    const pagePath = `/deployments/${ids.projectId}/runs`;

    // ── The project page: a card in the rail after the chats, before the
    //    environment, that opens the project's app under Deployments ──
    await page.goto(`/code/${ids.projectId}`);
    await expect(page.getByRole('heading', { level: 1, name: ids.name })).toBeVisible({
      timeout: 30_000,
    });
    const card = main.locator('section', {
      has: page.getByRole('heading', { level: 2, name: 'Pipeline and deployments' }),
    });
    // The rail is drawn once the card is: read the headings after it.
    await expect(card).toBeVisible({ timeout: 30_000 });
    const headings = await main.getByRole('heading', { level: 2 }).allTextContents();
    const at = (name: string) => headings.findIndex((text) => text.startsWith(name));
    expect(at('Pipeline and deployments')).toBeGreaterThan(at('Chats in this project'));
    expect(at('Environment')).toBeGreaterThan(at('Pipeline and deployments'));
    await expect(card.getByRole('link', { name: /Open in Deployments/ })).toHaveAttribute(
      'href',
      `/deployments/${ids.projectId}`
    );
    await expect(card.getByRole('button')).toHaveCount(0);
    await expectNoHorizontalOverflow(page);
    await shot('code-pipelines-card.png');

    // ── Into the app under Deployments, its Runs & variables tab: the runs
    //    table, the setup, the empty variable sets ──
    await card.getByRole('link', { name: /Open in Deployments/ }).click();
    await expect(page).toHaveURL(new RegExp(`/deployments/${ids.projectId}$`));
    await main
      .getByRole('navigation', { name: 'App' })
      .getByRole('link', { name: 'Runs & variables' })
      .click();
    await expect(page).toHaveURL(new RegExp(`${pagePath}$`));
    await expect(page.getByRole('heading', { level: 1, name: ids.name })).toBeVisible({
      timeout: 30_000,
    });
    await expect(main.getByText('Bitbucket Pipelines', { exact: false }).first()).toBeVisible();
    await expect(main.getByText(ids.repo)).toBeVisible();
    await expect(main.getByRole('link', { name: 'Open on Bitbucket' })).toHaveAttribute(
      'href',
      `https://bitbucket.org/${ids.repo}/pipelines`
    );
    const runs = main.getByRole('region', { name: 'Recent runs' });
    const rows = runs.getByRole('row');
    await expect(rows).toHaveCount(3);
    await expect(runs.getByRole('list')).toBeHidden();
    await expect(rows.nth(1)).toContainText('#2');
    await expect(rows.nth(1)).toContainText('Failed');
    await expect(rows.nth(1)).toContainText('feature/retry-invoices');
    await expect(rows.nth(1)).toContainText('E2E Dev');
    await expect(rows.nth(1)).toContainText('5m 12s');
    await expect(rows.nth(2)).toContainText('#1');
    await expect(rows.nth(2)).toContainText('Successful');
    await expect(rows.nth(2)).toContainText('main');
    const setup = main.getByRole('region', { name: 'Setup' });
    await expect(setup.getByText('Off', { exact: true })).toBeVisible();
    await expect(setup.getByText(/Not on main yet\./)).toBeVisible();
    await expect(setup.getByText(/A chat in this project can write one/)).toBeVisible();
    // No file yet: build one from blocks on the Pipeline tab, or write it by hand.
    await expect(setup.getByRole('link', { name: 'Build it from blocks' })).toHaveAttribute(
      'href',
      `/deployments/${ids.projectId}/pipeline`
    );
    await expect(setup.getByRole('button', { name: 'write one by hand' })).toBeVisible();
    const repositoryVariables = main.getByRole('region', { name: 'Repository variables' });
    const production = main.getByRole('region', { name: 'Production' });
    await expect(repositoryVariables.getByText('No variables.')).toBeVisible();
    await expect(production.getByText('No variables.')).toBeVisible();
    await expect(production.getByText(/deploying to this production environment/)).toBeVisible();
    await expectNoHorizontalOverflow(page);
    await shot('code-pipelines-page.png');

    // ── The one press through: the repository's variables as one text
    //    box — a secured line, a plain one, and a line that is nothing.
    //    The names appear, the bad line is reported, the secured value is
    //    never on the page ──
    await repositoryVariables.getByRole('button', { name: 'Add variables' }).click();
    const repoForm = repositoryVariables.getByRole('form', { name: 'Edit Repository variables' });
    const repoText = repoForm.getByLabel('Repository variables as text');
    await expect(repoText).toHaveValue('');
    await repoText.fill(
      'secret NPM_TOKEN=npm_secret_value_123\nAPI_BASE_URL: https://api.example.test\nthis line is broken\n'
    );
    await repoForm.getByRole('button', { name: 'Save' }).click();
    await expect(repositoryVariables.getByRole('status')).toContainText(
      'added NPM_TOKEN, API_BASE_URL'
    );
    await expect(repositoryVariables.getByText(/Not read as variables: line 3/)).toBeVisible();
    const npmRow = repositoryVariables.getByRole('listitem').filter({ hasText: 'NPM_TOKEN' });
    await expect(npmRow.getByText('Secured')).toBeVisible();
    const apiRow = repositoryVariables.getByRole('listitem').filter({ hasText: 'API_BASE_URL' });
    await expect(apiRow.getByText('https://api.example.test')).toBeVisible();
    await expect(page.getByText('npm_secret_value_123')).toHaveCount(0);
    await expectNoHorizontalOverflow(page);
    await shot('code-pipelines-variables.png');

    // ── The rest, staged through the routes the page calls: the switch on,
    //    the file committed, a run started, the production environment's
    //    secured variable ──
    const api = `/api/code/projects/${ids.projectId}/pipelines`;
    const ok = async (response: Promise<APIResponse>) => {
      const answered = await response;
      expect(answered.ok(), await answered.text()).toBe(true);
      return answered;
    };
    await ok(page.request.put(api, { data: { enabled: true } }));
    await ok(
      page.request.put(`${api}/config-file`, {
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
    const read: { environments: { uuid: string; name: string }[] } = await (
      await ok(page.request.get(api))
    ).json();
    const productionUuid = read.environments.find((env) => env.name === 'Production')?.uuid;
    expect(productionUuid).toBeTruthy();
    await ok(
      page.request.put(`${api}/variables`, {
        data: { text: 'secret DEPLOY_KEY=deploy-key-bytes', environmentUuid: productionUuid },
      })
    );

    // ── Drawn after a reload: the stub is the truth, not the page ──
    await page.reload();
    await expect(setup.getByText('On', { exact: true })).toBeVisible();
    await expect(setup.getByRole('button', { name: 'Turn off' })).toBeVisible();
    await expect(setup.getByText('On main.')).toBeVisible();
    await expect(setup.getByRole('button', { name: 'Edit file' })).toBeVisible();
    await expect(rows).toHaveCount(4);
    await expect(rows.nth(1)).toContainText('#3');
    await expect(rows.nth(1)).toContainText('Pending');
    await expect(rows.nth(1)).toContainText('E2E Dev');
    await expect(repositoryVariables.getByText('NPM_TOKEN')).toBeVisible();
    const deployRow = production.getByRole('listitem').filter({ hasText: 'DEPLOY_KEY' });
    await expect(deployRow.getByText('Secured')).toBeVisible();
    await expect(
      repositoryVariables.getByRole('listitem').filter({ hasText: 'DEPLOY_KEY' })
    ).toHaveCount(0);
    await expect(page.getByText('deploy-key-bytes')).toHaveCount(0);
    await shot('code-pipelines-set.png');

    // ── Phone width: the page again, one column, the runs as cards
    //    rather than a table, nothing sideways ──
    await page.setViewportSize(MOBILE_VIEWPORT);
    await page.goto(pagePath);
    await expect(page.getByRole('heading', { level: 1, name: ids.name })).toBeVisible();
    await expect(runs.getByRole('table')).toBeHidden();
    const runCards = runs.getByRole('listitem');
    await expect(runCards).toHaveCount(3);
    await expect(runCards.nth(0)).toContainText('#3');
    await expect(runCards.nth(1)).toContainText('#2');
    await expect(runCards.nth(1)).toContainText('Failed');
    await expect(runCards.nth(1)).toContainText('feature/retry-invoices');
    await expect(runCards.nth(1)).toContainText('5m 12s');
    // The forms fit the phone too.
    await runs.getByRole('button', { name: 'Run pipeline' }).click();
    await expect(runs.getByRole('form', { name: 'Run pipeline' })).toBeVisible();
    await runs.getByRole('button', { name: 'Cancel' }).click();
    await production.getByRole('button', { name: 'Edit variables' }).click();
    await expect(
      production.getByRole('form', { name: 'Edit Production' }).getByLabel('Production as text')
    ).toHaveValue('secret DEPLOY_KEY=');
    await expectNoHorizontalOverflow(page);
    await shot('code-pipelines-mobile.png');
  });

  test('a code chat’s overflow menu opens the project’s runs and variables in a new tab', async ({
    page,
  }) => {
    const chatId = await createChat(page.request, { projectId: ids.projectId, title: 'Draft CI' });
    await page.goto(`/chat/${chatId}`);
    const main = page.getByRole('main');
    await main.getByRole('button', { name: 'More', exact: true }).click();
    const opened = page.waitForEvent('popup');
    await page.getByRole('menuitem', { name: 'Deployments' }).click();
    const tab = await opened;
    await expect(tab).toHaveURL(new RegExp(`/deployments/${ids.projectId}/runs$`));
    const there = tab.getByRole('main');
    await expect(there.getByRole('region', { name: 'Recent runs' })).toBeVisible({
      timeout: 30_000,
    });
    await expect(there.getByRole('region', { name: 'Setup' })).toBeVisible();
    await expect(there.getByRole('region', { name: 'Repository variables' })).toBeVisible();
    await expect(there.getByRole('link', { name: 'Open on Bitbucket' })).toBeVisible();
    // The chat stays where it was.
    await expect(page).toHaveURL(new RegExp(`/chat/${chatId}$`));
    await tab.close();
  });
});
