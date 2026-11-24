/**
 * A code project's Environments page, end to end in a browser, on a
 * Bitbucket repository: from the project page to the page; production
 * given its one branch; a second environment added and given a branch of
 * the remote; that branch's pipeline built from blocks and put in a pull
 * request against it; its variables read from a `.env` file picked in the
 * browser, one locked as a secret, and saved — the request carrying the
 * rows, and the host making the deployment environment for them; and a
 * deploy step's report (signed as Bitbucket signs a step's) showing what
 * runs there. A report without a host's token is refused. The page fits a
 * phone. The old addresses under /deployments land here.
 *
 * Bitbucket is the sandbox stub's (`acme/pipeline-demo-*`: branches main
 * and develop, and its OIDC issuer). Where the rules went: one production
 * environment, one branch on it, a branch in one environment —
 * lib/ci/environment-rules.test.ts; what is picked and what each change
 * sends — environments-page.model.test.ts; what a `.env` adds, the lock,
 * and what Save sends — variables-editor.model.test.ts; what the host is
 * asked — lib/code/host-variables.test.ts; the builder —
 * pipeline-builder.model.test.ts; recording reports —
 * lib/ci/deployment-reports.test.ts.
 *
 * The blocks and the target are organization-wide: they carry this run's
 * tag and go again through the admin routes at the end.
 */

import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { APIRequestContext, Page, TestInfo } from '@playwright/test';
import { test, expect } from './fixtures';
import { SANDBOX_STUB_URL } from './constants';
import { connectBitbucket, createCodeProject, prepareCodeHost } from './support/code-host';

test.use({ roles: ['renkei-user', 'renkei-operator'] });

const DEV_COMMIT = '8e41c2a9f0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5';

/**
 * The page scrolls inside the app's frame, so a desktop shot grows the
 * window to what the frame holds, takes it, and puts the window back.
 */
async function shot(page: Page, testInfo: TestInfo, name: string, whole = true): Promise<void> {
  const size = page.viewportSize();
  if (whole && size) {
    const height = await page.evaluate(() => {
      const frame = document.querySelector('main .overflow-y-auto');
      return frame ? frame.scrollHeight + (window.innerHeight - frame.clientHeight) : 0;
    });
    await page.setViewportSize({
      width: size.width,
      height: Math.min(Math.max(height, 900), 2600),
    });
  }
  await capture(page, testInfo, name);
  if (whole && size) await page.setViewportSize(size);
}

async function capture(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  const fullPage = false;
  await page.screenshot({
    path: path.join(
      import.meta.dirname,
      '..',
      'test-results',
      'screens',
      testInfo.project.name,
      `${name}.png`
    ),
    fullPage,
  });
}

async function created(request: APIRequestContext, url: string, data: unknown): Promise<string> {
  const response = await request.post(url, { data });
  expect(response.status(), await response.text()).toBe(201);
  const body: unknown = await response.json();
  const id = typeof body === 'object' && body !== null && 'id' in body ? body.id : null;
  if (typeof id !== 'string') throw new Error(`no id from ${url}`);
  return id;
}

function field(body: unknown, name: string): unknown {
  return typeof body === 'object' && body !== null && name in body
    ? Reflect.get(body, name)
    : undefined;
}

test('environments: branches, a branch’s pipeline, variables from a .env, and what runs @smoke', async ({
  page,
  request,
  person: _person,
}, testInfo) => {
  // A dev server compiles each route the first time it is asked for one.
  test.setTimeout(240_000);
  const tag = `${testInfo.project.name}-${randomUUID().slice(0, 6)}`;
  const buildName = `Build ${tag}`;
  const deployName = `Deploy ${tag}`;
  const target = `env-${tag}`;
  const repo = `acme/pipeline-demo-${tag}`;
  const blockIds: string[] = [];
  let targetId: string | null = null;

  await prepareCodeHost(request);
  await connectBitbucket(page);
  try {
    for (const block of [
      {
        key: `build-${tag}`,
        name: buildName,
        kind: 'build',
        definition: {
          kind: 'build',
          runsOn: { type: 'hosted', image: 'node:22' },
          inputs: [],
          variables: [],
          consumes: [],
          produces: [{ name: 'dist', paths: ['dist'] }],
          caches: [],
          commands: 'npm ci && npm run build',
        },
      },
      {
        key: `deploy-${tag}`,
        name: deployName,
        kind: 'deploy',
        definition: {
          kind: 'deploy',
          runsOn: { type: 'target' },
          inputs: [{ name: 'service_name', type: 'text', description: 'The systemd unit' }],
          variables: [{ name: 'DEPLOY_TOKEN', secured: true }],
          consumes: ['dist'],
          produces: [],
          caches: [],
          commands: 'sudo systemctl restart ${input.service_name}',
        },
      },
    ]) {
      const id = await created(page.request, '/api/admin/ci-blocks', {
        ...block,
        description: null,
      });
      blockIds.push(id);
      const published = await page.request.post(`/api/admin/ci-blocks/${id}/publish`);
      expect(published.ok(), await published.text()).toBe(true);
    }
    targetId = await created(page.request, '/api/admin/ci-targets', {
      name: target,
      description: null,
      labels: { bitbucket: ['self.hosted', target], github: [] },
    });
    const projectId = await createCodeProject(page.request, {
      name: `Environments demo (${tag})`,
      repository: repo,
      branch: 'main',
    });

    // From the project page to its Environments.
    await page.goto(`/code/${projectId}`);
    const main = page.getByRole('main');
    await main
      .getByTestId('code-repo-strip')
      .getByRole('link', { name: 'Pipelines', exact: true })
      .click();
    await expect(page).toHaveURL(new RegExp(`/code/${projectId}/environments`), {
      timeout: 30_000,
    });
    await expect(main.getByRole('heading', { name: 'Environments', level: 1 })).toBeVisible({
      timeout: 30_000,
    });
    const environments = main.getByRole('navigation', { name: 'Environments' });
    const panel = main.getByRole('region', { name: 'production', exact: true });
    await expect(panel).toContainText('No branch is assigned yet', { timeout: 30_000 });
    await shot(page, testInfo, 'environments-01-empty');

    // Production takes its one branch, from the remote's.
    await panel.getByRole('combobox', { name: 'A branch of the repository' }).selectOption('main');
    await panel.getByRole('button', { name: 'Assign the branch' }).click();
    await expect(
      panel.getByRole('list', { name: 'Branches of production' }).getByRole('button', {
        name: 'main',
        exact: true,
      })
    ).toBeVisible();
    await expect(panel.getByRole('button', { name: 'Replace the branch' })).toBeVisible();

    // A second environment, named by the project, with a branch of its own.
    await environments.getByRole('button', { name: '+ Add an environment' }).click();
    const form = main.getByRole('form', { name: 'Add an environment' });
    await form.getByRole('textbox').fill('dev');
    await form.getByRole('button', { name: 'Add it' }).click();
    const dev = main.getByRole('region', { name: 'dev', exact: true });
    await dev.getByRole('combobox', { name: 'A branch of the repository' }).selectOption('develop');
    await dev.getByRole('button', { name: 'Assign the branch' }).click();
    await expect(
      dev
        .getByRole('list', { name: 'Branches of dev' })
        .getByRole('button', { name: 'develop', exact: true })
    ).toBeVisible();
    await expect(page).toHaveURL(/env=dev&branch=develop/);

    // The branch's pipeline: suggested from its files, a deploy added, into a pull request.
    const found = main.getByRole('region', { name: 'Found in this repository' });
    await expect(found).toContainText('No bitbucket-pipelines.yml on develop yet', {
      timeout: 30_000,
    });
    const deploys = main.getByRole('region', { name: 'Environment dev' });
    await deploys.getByRole('button', { name: '+ Add block' }).click();
    await deploys.getByRole('button', { name: new RegExp(`^Deploy\\s*${deployName}`) }).click();
    const editor = deploys.getByRole('group', { name: new RegExp(`^${deployName}, dev, step`) });
    await editor.getByRole('combobox', { name: 'Target' }).selectOption(target);
    await editor.getByRole('textbox', { name: 'service_name' }).fill('billing');
    await editor.getByRole('button', { name: 'Done' }).click();
    await shot(page, testInfo, 'environments-02-pipeline');
    const opened = page.waitForResponse(
      (r) =>
        r.url().includes('/pipeline-builder/pull-request?branch=develop') &&
        r.request().method() === 'POST'
    );
    await main.getByRole('button', { name: 'Open a pull request with the pipeline' }).click();
    expect((await opened).status()).toBe(200);
    await expect(main.getByRole('status')).toContainText('Pull request opened with the pipeline.');
    await expect(
      main.getByRole('status').getByRole('link', { name: 'Open it on Bitbucket' })
    ).toHaveAttribute('href', `https://bitbucket.org/${repo}/pull-requests/1`);

    // The variables: a .env file read in the browser, a secret locked, then saved.
    await main.getByRole('tab', { name: 'Variables' }).click();
    const devVariables = main.getByTestId('variables-environment-dev');
    await expect(devVariables).toContainText('Bitbucket has no deployment environment named dev', {
      timeout: 30_000,
    });
    await devVariables.getByLabel('An environment file for dev variables').setInputFiles({
      name: 'dev.env',
      mimeType: 'text/plain',
      buffer: Buffer.from(
        '# dev\nAPI_BASE_URL=https://api.dev.example.test\nDEPLOY_TOKEN=tok-e2e-123\nREGION="eu-west-1"\n'
      ),
    });
    await expect(devVariables.getByRole('status')).toContainText(
      'Read 3 variables from dev.env: 3 new.'
    );
    // A name that reads as a secret arrives locked; another is locked by hand.
    await expect(
      devVariables.getByRole('button', { name: 'DEPLOY_TOKEN is a secret' })
    ).toHaveAttribute('aria-pressed', 'true');
    await devVariables.getByRole('button', { name: 'REGION is a secret' }).click();
    await shot(page, testInfo, 'environments-03-variables');
    const saved = page.waitForRequest(
      (r) => r.url().endsWith(`/api/code/projects/${projectId}/variables`) && r.method() === 'PUT'
    );
    await devVariables.getByRole('button', { name: 'Save' }).click();
    expect((await saved).postDataJSON()).toEqual({
      scope: 'environment',
      environment: 'dev',
      set: [
        { key: 'API_BASE_URL', value: 'https://api.dev.example.test', secured: false },
        { key: 'DEPLOY_TOKEN', value: 'tok-e2e-123', secured: true },
        { key: 'REGION', value: 'eu-west-1', secured: true },
      ],
      remove: [],
    });
    await expect(devVariables.getByRole('status')).toContainText(
      'Saved: added API_BASE_URL, DEPLOY_TOKEN, REGION. The deployment environment dev was made on the host.'
    );
    // A secret's value does not come back: its box is empty, to be replaced.
    await expect(devVariables.getByLabel('Value of DEPLOY_TOKEN')).toHaveValue('');
    await expect(devVariables.getByLabel('Value of API_BASE_URL')).toHaveValue(
      'https://api.dev.example.test'
    );

    // A deploy step reports, with the token Bitbucket gives its step.
    const repository: unknown = await (
      await request.get(`${SANDBOX_STUB_URL}/bitbucket/2.0/repositories/${repo}`)
    ).json();
    const repositoryUuid = field(repository, 'uuid');
    const token = String(
      field(
        await (
          await request.post(`${SANDBOX_STUB_URL}/e2e/bitbucket-step-token`, {
            data: { repositoryUuid, branchName: 'develop' },
          })
        ).json(),
        'token'
      )
    );
    for (const status of ['started', 'succeeded']) {
      const response = await page.request.post('/api/deployments/report', {
        headers: { Authorization: `Bearer ${token}` },
        data: {
          environment: 'dev',
          status,
          commit: DEV_COMMIT,
          branch: 'develop',
          run: '101',
          target,
          detail: '',
        },
      });
      expect(response.status(), await response.text()).toBe(200);
    }
    const refused = await page.request.post('/api/deployments/report', {
      headers: { Authorization: 'Bearer not-a-token' },
      data: { environment: 'dev', status: 'succeeded', commit: DEV_COMMIT },
    });
    expect(refused.status()).toBe(401);

    // The old address lands here; the address keeps what was picked.
    await page.goto(`/deployments/${projectId}/runs`);
    await expect(page).toHaveURL(new RegExp(`/code/${projectId}/environments`));
    await environments.getByRole('button', { name: /^dev/ }).click();
    await expect(dev).toContainText('Healthy', { timeout: 30_000 });
    await expect(dev).toContainText('8e41c2a');
    await expect(dev).toContainText('Pipeline built here, in a pull request');
    await expect(main.getByRole('region', { name: 'Deployments of dev' })).toContainText(
      'Pipelines #101'
    );
    await main.getByRole('tab', { name: 'Runs' }).click();
    await expect(main.getByRole('heading', { name: 'Runs' })).toBeVisible({ timeout: 30_000 });
    await shot(page, testInfo, 'environments-04-runs');

    // At a phone's width nothing scrolls sideways.
    await page.setViewportSize({ width: 390, height: 844 });
    await main.getByRole('tab', { name: 'Variables' }).click();
    await expect(devVariables.getByLabel('Value of API_BASE_URL')).toBeVisible();
    const overflow = await page.evaluate(() => {
      const frame = document.querySelector('main .overflow-y-auto');
      return Math.max(
        document.documentElement.scrollWidth - document.documentElement.clientWidth,
        frame ? frame.scrollWidth - frame.clientWidth : 0
      );
    });
    expect(overflow).toBeLessThanOrEqual(0);
    await shot(page, testInfo, 'environments-05-phone', false);
  } finally {
    for (const id of blockIds) await page.request.delete(`/api/admin/ci-blocks/${id}`);
    if (targetId) await page.request.delete(`/api/admin/ci-targets/${targetId}`);
  }
});
