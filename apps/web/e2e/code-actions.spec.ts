/**
 * A GitHub code project's Actions, in a browser: the card on the project
 * page (off, no workflow files, the last run) opening the Actions page,
 * which renders the recent runs, the setup and the variable sets on the
 * real server — the repository's with its secret listed by name only —
 * and, through one press each, the switch turned on, a variable set saved
 * from the text box (a `secret` line refused, a plain one landing) and a
 * workflow file committed from the editor; then the same panel in the
 * dialog a code chat's overflow menu opens, with what the page did drawn
 * there. GitHub is the stub in sandbox-stub.mjs (`acme/actions-demo-*`,
 * one Actions row per repository); each test's person makes a project on
 * a repository of its own, connected through the real flow with the
 * Configure Actions capability (e2e/support/code-host.ts).
 *
 * Where its rules went: the editor's name and commit rules, what each
 * request sends, the words on the page — actions-page.model.test.ts and
 * actions-summary.model.test.ts; what a chat may write to the variables
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

  test('card, page, the switch, a variable set, a workflow file, the chat’s dialog', async ({
    page,
  }) => {
    // A dev server compiles each route the first time it is asked for one.
    test.setTimeout(180_000);
    const main = page.getByRole('main');

    // ── The project page: the card summarizes what GitHub says ──
    await page.goto(`/code/${ids.projectId}`);
    await expect(page.getByRole('heading', { level: 1, name: ids.name })).toBeVisible({
      timeout: 30_000,
    });
    const card = main.locator('section', {
      has: page.getByRole('heading', { level: 2, name: 'Actions' }),
    });
    await expect(
      card.getByText(
        /^Off · no workflow files on main yet · 0 variables across the repository and 1 environment/
      )
    ).toBeVisible();
    await expect(card.getByRole('link', { name: 'Run 9002' })).toHaveAttribute(
      'href',
      `https://github.com/${ids.repo}/actions/runs/9002`
    );
    await expect(card.getByText('Failure')).toBeVisible();

    // ── Into the page: runs, setup, the sets with the secret by name ──
    await card.getByRole('link', { name: /Runs, setup & variables/ }).click();
    await expect(page.getByRole('heading', { level: 1, name: /^Actions/ })).toBeVisible({
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

    // ── A workflow file, started blank and committed ──
    await setup.getByRole('button', { name: 'Start from a template' }).click();
    const file = setup.getByRole('form', { name: 'Workflow file' });
    await expect(file.getByRole('button', { name: 'Commit' })).toBeDisabled();
    await file.getByLabel('File name').fill('ci.yml');
    await file.locator('textarea').fill('name: CI\non: [push]\njobs: {}\n');
    await file.getByRole('button', { name: 'Commit' }).click();
    await expect(setup.getByRole('status')).toContainText('Committed ci.yml to main.');
    await expect(setup.getByText('1 on main.')).toBeVisible();
    await expect(setup.getByRole('button', { name: 'Edit ci.yml' })).toBeVisible();

    // ── The chat's dialog: the same panel, with what the page just did ──
    const chatId = await createChat(page.request, { projectId: ids.projectId, title: 'Draft CI' });
    await page.goto(`/chat/${chatId}`);
    await main.getByRole('button', { name: 'More', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Pipelines' }).click();
    const dialog = page.getByRole('dialog', { name: 'Actions' });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText('1 on main.')).toBeVisible();
    await expect(
      dialog
        .getByRole('listitem')
        .filter({ hasText: 'API_BASE_URL' })
        .getByText('https://api.example.test')
    ).toBeVisible();
    await expect(dialog.getByRole('heading', { level: 1 })).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
  });
});
