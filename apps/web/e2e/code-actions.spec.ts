/**
 * A GitHub code project's runs and variables, by branch, in a browser:
 * the project page's link opening its Environments page; production's
 * branch's Runs tab rendering the recent runs and the setup on the real
 * server and, through one press each, the switch turned on and a workflow
 * file committed to the branch from the editor; its Variables tab listing
 * the repository's secret by name only, then a `.env` file picked in the
 * browser, a token locked, and saved — the secret reaching GitHub sealed
 * to the repository's key (the stand-in opens it as GitHub does and
 * refuses one that is not), its value gone from the page; then the same
 * page opened from a code chat's More menu, in a new tab. GitHub is the
 * stub in sandbox-stub.mjs (`acme/actions-demo-*`, one Actions row per
 * repository); each test's person makes a project on a repository of its
 * own, connected through the real flow with the Configure Actions
 * capability (e2e/support/code-host.ts).
 *
 * Where its rules went: the editor's name and commit rules, what each
 * request sends, the words on the page — actions-page.model.test.ts; the
 * variable rows, the lock and what Save sends —
 * variables-editor.model.test.ts; sealing — lib/code/sealed-box.test.ts;
 * what GitHub is asked — lib/code/host-variables.test.ts; what a chat may
 * write to the variables — lib/code/pipeline-tools.test.ts.
 */

import { randomUUID } from 'node:crypto';
import type { Page, TestInfo } from '@playwright/test';
import { test, expect } from './fixtures';
import {
  assignEnvironments,
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
  await assignEnvironments(page.request, projectId);
  return { projectId, name, repo };
}

test.describe('Code project Actions', () => {
  let ids: Ids;
  test.beforeEach(async ({ page, request, person: _person }, testInfo) => {
    await prepareCodeHost(request);
    await connectCodeHost(page, 'github');
    ids = await stage(page, testInfo);
  });

  test('the project page link, a branch’s Runs tab, the switch, a workflow file, a secret from a .env, the chat’s link', async ({
    page,
  }) => {
    // A dev server compiles each route the first time it is asked for one.
    test.setTimeout(180_000);
    const main = page.getByRole('main');

    // ── The project page: its repository strip links to its Environments ──
    await page.goto(`/code/${ids.projectId}`);
    await expect(page.getByRole('heading', { level: 1, name: ids.name })).toBeVisible({
      timeout: 30_000,
    });
    await main
      .getByTestId('code-repo-strip')
      .getByRole('link', { name: 'Actions', exact: true })
      .click();
    await expect(page).toHaveURL(new RegExp(`/code/${ids.projectId}/environments`));

    // ── Production's branch, the Runs tab: runs and setup ──
    await main.getByRole('tab', { name: 'Runs' }).click();
    await expect(main.getByRole('link', { name: 'Open on GitHub' })).toHaveAttribute(
      'href',
      `https://github.com/${ids.repo}/actions`,
      { timeout: 30_000 }
    );
    const runs = main.getByRole('region', { name: 'Recent runs' });
    await expect(runs.getByRole('row').nth(1)).toBeVisible({ timeout: 30_000 });
    const setup = main.getByRole('region', { name: 'Setup' });
    await expect(setup.getByText('Off', { exact: true })).toBeVisible();
    await expect(setup.getByText(/No workflow files on main yet\./)).toBeVisible();

    // ── The switch ──
    await setup.getByRole('button', { name: 'Turn on' }).click();
    await expect(setup.getByText('On', { exact: true })).toBeVisible();

    // ── A workflow file, written by hand and committed to the branch ──
    await setup.getByRole('button', { name: 'or write one by hand' }).click();
    const file = setup.getByRole('form', { name: 'Workflow file' });
    await expect(file.getByRole('button', { name: 'Commit' })).toBeDisabled();
    await file.getByLabel('File name').fill('ci.yml');
    await file.locator('textarea').fill('name: CI\non: [push]\njobs: {}\n');
    await file.getByRole('button', { name: 'Commit' }).click();
    await expect(setup.getByRole('status')).toContainText('Committed ci.yml to main.');
    await expect(setup.getByText('1 on main.')).toBeVisible();
    await expect(setup.getByRole('button', { name: 'Edit ci.yml' })).toBeVisible();

    // ── The Variables tab: the repository's secret by name only ──
    await main.getByRole('tab', { name: 'Variables' }).click();
    const repository = main.getByTestId('variables-repository');
    await expect(
      repository.getByRole('button', { name: 'DEPLOY_TOKEN is a secret' })
    ).toHaveAttribute('aria-pressed', 'true', { timeout: 30_000 });
    await expect(repository.getByLabel('Value of DEPLOY_TOKEN')).toHaveValue('');

    // ── A .env file, read in the browser: nothing is sent until Save ──
    let sent = 0;
    page.on('request', (request) => {
      if (request.url().endsWith(`/api/code/projects/${ids.projectId}/variables`)) {
        if (request.method() === 'PUT') sent += 1;
      }
    });
    await repository.getByLabel('An environment file for Repository variables').setInputFiles({
      name: '.env',
      mimeType: 'text/plain',
      buffer: Buffer.from('API_BASE_URL=https://api.example.test\nNPM_TOKEN=npm_s3cret_value\n'),
    });
    await expect(repository.getByRole('status')).toContainText(
      'Read 2 variables from .env: 2 new.'
    );
    // A name that reads as a secret arrives locked.
    await expect(repository.getByRole('button', { name: 'NPM_TOKEN is a secret' })).toHaveAttribute(
      'aria-pressed',
      'true'
    );
    expect(sent).toBe(0);
    await repository.getByRole('button', { name: 'Save' }).click();
    // GitHub's stand-in opened the sealed secret with its own key, or it would have refused it.
    await expect(repository.getByRole('status')).toContainText(
      'Saved: added API_BASE_URL, NPM_TOKEN.'
    );
    expect(sent).toBe(1);
    await expect(repository.getByLabel('Value of API_BASE_URL')).toHaveValue(
      'https://api.example.test'
    );
    await expect(repository.getByLabel('Value of NPM_TOKEN')).toHaveValue('');
    expect(await page.content()).not.toContain('npm_s3cret_value');

    // ── The chat's More menu opens the same page, with what was just done ──
    const chatId = await createChat(page.request, { projectId: ids.projectId, title: 'Draft CI' });
    await page.goto(`/chat/${chatId}`);
    await main.getByRole('button', { name: 'More', exact: true }).click();
    const opened = page.waitForEvent('popup');
    await page.getByRole('menuitem', { name: 'Actions', exact: true }).click();
    const tab = await opened;
    await expect(tab).toHaveURL(new RegExp(`/code/${ids.projectId}/environments`));
    const there = tab.getByRole('main');
    await there.getByRole('tab', { name: 'Runs' }).click();
    await expect(there.getByText('1 on main.')).toBeVisible({ timeout: 30_000 });
    await there.getByRole('tab', { name: 'Variables' }).click();
    await expect(
      there.getByTestId('variables-repository').getByLabel('Value of API_BASE_URL')
    ).toHaveValue('https://api.example.test', { timeout: 30_000 });
    await tab.close();
  });
});
