/**
 * A GitHub code project's Actions, in a browser: the card on the project
 * page opening its app under Deployments, whose Runs & variables tab
 * renders the recent runs, the setup and the variable sets on the
 * real server — the repository's with its secret listed by name only —
 * and, through one press each, the switch turned on, a variable set saved
 * from the text box (a `secret` line refused, a plain one landing) and a
 * workflow file committed from the editor; then the same tab opened from
 * a code chat's More menu, in a new tab, with what the page did drawn
 * there. GitHub is the stub in sandbox-stub.mjs (`acme/actions-demo-*`,
 * one Actions row per repository); each test's person makes a project on
 * a repository of its own, connected through the real flow with the
 * Configure Actions capability (e2e/support/code-host.ts).
 *
 * Where its rules went: the editor's name and commit rules, what each
 * request sends, the words on the page — actions-page.model.test.ts; what a chat may write to the variables
 * — lib/code/pipeline-tools.test.ts.
 */

import { randomUUID } from 'node:crypto';
import type { Page, TestInfo } from '@playwright/test';
import { test, expect } from './fixtures';
import {
  connectCodeHost,
  createChat,
  createCodeProject,
  prepareCodeHost,
} from './support/code-host';

// The registration is an operator's; the person is a plain user of it.
test.use({ roles: ['renkei-user', 'renkei-operator'] });

interface Ids {
  projectId: string;
  name: string;
  repo: string;
}

async function stage(page: Page, testInfo: TestInfo): Promise<Ids> {
  const tag = `${testInfo.project.name}-${randomUUID().slice(0, 6)}`;
  const name = `Actions demo (${tag})`;
  const repo = `acme/actions-demo-${tag}`;
  const projectId = await createCodeProject(page.request, {
    provider: 'github',
    name,
    description: 'Where the workflow gets set up.',
    repository: repo,
    branch: 'main',
  });
  return { projectId, name, repo };
}

test.describe('Code project Actions', () => {
  let ids: Ids;
  test.beforeEach(async ({ page, request, person: _person }, testInfo) => {
    await prepareCodeHost(request);
    await connectCodeHost(page, 'github');
    ids = await stage(page, testInfo);
  });

  test('card, the Runs & variables tab, the switch, a variable set, a workflow file, the chat’s link', async ({
    page,
  }) => {
    // A dev server compiles each route the first time it is asked for one.
    test.setTimeout(180_000);
    const main = page.getByRole('main');

    // ── The project page: its card opens the app under Deployments ──
    await page.goto(`/code/${ids.projectId}`);
    await expect(page.getByRole('heading', { level: 1, name: ids.name })).toBeVisible({
      timeout: 30_000,
    });
    const card = main.locator('section', {
      has: page.getByRole('heading', { level: 2, name: 'Pipeline and deployments' }),
    });
    await expect(card).toContainText('GitHub runs and variables');

    // ── Its Runs & variables tab: runs, setup, the sets with the secret by name ──
    await card.getByRole('link', { name: /Open in Deployments/ }).click();
    await main
      .getByRole('navigation', { name: 'App' })
      .getByRole('link', { name: 'Runs & variables' })
      .click();
    await expect(page).toHaveURL(new RegExp(`/deployments/${ids.projectId}/runs$`));
    await expect(page.getByRole('heading', { level: 1, name: ids.name })).toBeVisible({
      timeout: 30_000,
    });
    await expect(main.getByRole('link', { name: 'Open on GitHub' })).toHaveAttribute(
      'href',
      `https://github.com/${ids.repo}/actions`
    );
    const runs = main.getByRole('region', { name: 'Recent runs' });
    await expect(runs.getByRole('row')).toHaveCount(3);
    const setup = main.getByRole('region', { name: 'Setup' });
    await expect(setup.getByText('Off', { exact: true })).toBeVisible();
    await expect(setup.getByText(/No workflow files on main yet\./)).toBeVisible();
    const repository = main.getByRole('region', { name: 'Repository variables' });
    const secretRow = repository.getByRole('listitem').filter({ hasText: 'DEPLOY_TOKEN' });
    await expect(secretRow.getByText('Secured')).toBeVisible();
    await expect(repository.getByRole('link', { name: 'Open secrets on GitHub' })).toHaveAttribute(
      'href',
      `https://github.com/${ids.repo}/settings/secrets/actions`
    );

    // ── The switch ──
    await setup.getByRole('button', { name: 'Turn on' }).click();
    await expect(setup.getByText('On', { exact: true })).toBeVisible();

    // ── A variable set: a plain line lands, a secret line is refused by name ──
    await repository.getByRole('button', { name: 'Add variables' }).click();
    const form = repository.getByRole('form', { name: 'Edit Repository variables' });
    await form
      .getByLabel('Repository variables as text')
      .fill('API_BASE_URL=https://api.example.test\nsecret NPM_TOKEN=nope\n');
    await form.getByRole('button', { name: 'Save' }).click();
    await expect(repository.getByRole('status')).toContainText('added API_BASE_URL');
    await expect(repository.getByRole('alert')).toContainText('NPM_TOKEN');
    await expect(
      repository
        .getByRole('listitem')
        .filter({ hasText: 'API_BASE_URL' })
        .getByText('https://api.example.test')
    ).toBeVisible();
    await expect(page.getByText('nope')).toHaveCount(0);

    // ── A workflow file, written by hand and committed (or built from blocks) ──
    await expect(setup.getByRole('link', { name: 'Build one from blocks' })).toHaveAttribute(
      'href',
      `/deployments/${ids.projectId}/pipeline`
    );
    await setup.getByRole('button', { name: 'or write one by hand' }).click();
    const file = setup.getByRole('form', { name: 'Workflow file' });
    await expect(file.getByRole('button', { name: 'Commit' })).toBeDisabled();
    await file.getByLabel('File name').fill('ci.yml');
    await file.locator('textarea').fill('name: CI\non: [push]\njobs: {}\n');
    await file.getByRole('button', { name: 'Commit' }).click();
    await expect(setup.getByRole('status')).toContainText('Committed ci.yml to main.');
    await expect(setup.getByText('1 on main.')).toBeVisible();
    await expect(setup.getByRole('button', { name: 'Edit ci.yml' })).toBeVisible();

    // ── The chat's More menu opens the same tab, with what the page just did ──
    const chatId = await createChat(page.request, { projectId: ids.projectId, title: 'Draft CI' });
    await page.goto(`/chat/${chatId}`);
    await main.getByRole('button', { name: 'More', exact: true }).click();
    const opened = page.waitForEvent('popup');
    await page.getByRole('menuitem', { name: 'Deployments' }).click();
    const tab = await opened;
    await expect(tab).toHaveURL(new RegExp(`/deployments/${ids.projectId}/runs$`));
    const there = tab.getByRole('main');
    await expect(there.getByText('1 on main.')).toBeVisible({ timeout: 30_000 });
    await expect(
      there
        .getByRole('listitem')
        .filter({ hasText: 'API_BASE_URL' })
        .getByText('https://api.example.test')
    ).toBeVisible();
    await tab.close();
  });
});
