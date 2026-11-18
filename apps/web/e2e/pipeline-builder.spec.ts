/**
 * A code project's pipeline builder, end to end in a browser, on a
 * Bitbucket repository: the project page's card opens its app under
 * Deployments, whose Pipeline tab it is;
 * it shows what was found in the repository and the pipeline saved for
 * the project; a deploy block is added to production from the picker,
 * given its target and input; the file it writes says so; the pull
 * request opens through the real route and the stand-in host, then a
 * change goes to the same pull request; the file on main is untouched
 * until it merges; and the page fits a phone.
 *
 * Bitbucket is the sandbox stub's (`acme/pipeline-demo-*`: branches, pull
 * requests, and commits kept on the branch they name). Where the rules
 * went: the rows, picker, editor and what Save and the pull request send —
 * pipeline-builder.model.test.ts; the file and the checks —
 * packages/ci-blocks pipeline.test.ts; the branch, commit and pull request
 * on each host — lib/ci/pipeline-builder.test.ts.
 *
 * The blocks and the target are organization-wide: they carry this run's
 * tag and go again through the admin routes at the end.
 */

import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { APIRequestContext, Page, TestInfo } from '@playwright/test';
import { test, expect } from './fixtures';
import { connectBitbucket, createCodeProject, prepareCodeHost } from './support/code-host';

test.use({ roles: ['renkei-user', 'renkei-operator'] });

async function shot(page: Page, testInfo: TestInfo, name: string, fullPage = true): Promise<void> {
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

test('pipeline builder: add a deploy, open the pull request, update it @smoke', async ({
  page,
  request,
  person: _person,
}, testInfo) => {
  // A dev server compiles each route the first time it is asked for one.
  test.setTimeout(180_000);
  const tag = `${testInfo.project.name}-${randomUUID().slice(0, 6)}`;
  const buildName = `Build ${tag}`;
  const deployName = `Deploy ${tag}`;
  const target = `pipe-${tag}`;
  const blockIds: string[] = [];
  let targetId: string | null = null;

  await prepareCodeHost(request);
  await connectBitbucket(page);
  try {
    // Two published blocks and a target, as an operator makes them.
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
          variables: [],
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

    // A project on a repository of its own, with a pipeline saved for it.
    const projectId = await createCodeProject(page.request, {
      name: `Pipeline demo (${tag})`,
      repository: `acme/pipeline-demo-${tag}`,
      branch: 'main',
    });
    const build = { block: `build-${tag}`, version: 1, inputs: {} };
    const staged = await page.request.put(`/api/code/projects/${projectId}/pipeline-builder`, {
      data: {
        spec: {
          checks: [build],
          environments: [{ name: 'production', branch: 'main', steps: [build] }],
        },
      },
    });
    expect(staged.ok(), await staged.text()).toBe(true);

    // From the project page's card, to its app under Deployments, to the Pipeline tab.
    await page.goto(`/code/${projectId}`);
    const main = page.getByRole('main');
    await main.getByRole('link', { name: /Open in Deployments/ }).click();
    await main
      .getByRole('navigation', { name: 'App' })
      .getByRole('link', { name: 'Pipeline' })
      .click();
    await expect(page).toHaveURL(new RegExp(`/deployments/${projectId}/pipeline$`));
    const found = main.getByRole('region', { name: 'Found in this repository' });
    await expect(found).toContainText('Node · package.json', { timeout: 30_000 });
    await expect(found).toContainText('No bitbucket-pipelines.yml on main yet');

    // A deploy added to production, its target and input filled in.
    const production = main.getByRole('region', { name: 'Environment production' });
    await production.getByRole('button', { name: '+ Add block' }).click();
    await production.getByRole('button', { name: new RegExp(`^Deploy\\s*${deployName}`) }).click();
    const editor = production.getByRole('group', { name: `${deployName}, production, step 2` });
    // Targets are organization-wide, and another spec's may sort first: pick this run's.
    await editor.getByRole('combobox', { name: 'Target' }).selectOption(target);
    await expect(editor.getByRole('combobox', { name: 'Target' })).toHaveValue(target);
    await editor.getByRole('textbox', { name: 'service_name' }).fill('billing');
    await editor.getByRole('button', { name: 'Done' }).click();
    await expect(production).toContainText(`target ${target}`);
    await expect(production).toContainText('service_name: billing');

    const checks = main.getByRole('region', { name: 'Before it runs' });
    await expect(checks).toContainText(
      `No Bitbucket runner carries target ${target}’s labels yet; its steps wait for one.`
    );

    // The file it writes.
    await main.getByRole('tab', { name: 'The file it writes' }).click();
    const file = main.getByRole('region', { name: 'The file it writes' });
    await expect(file).toContainText('deployment: production');
    await expect(file).toContainText(`# block: deploy-${tag}@v1, target pipe-${tag}`);
    await expect(file).toContainText('sudo systemctl restart billing');
    await shot(page, testInfo, 'pipeline-builder-00-file');
    await main.getByRole('tab', { name: 'Builder' }).click();

    // The pull request, through the route and the host.
    const opened = page.waitForResponse(
      (r) => r.url().endsWith('/pipeline-builder/pull-request') && r.request().method() === 'POST'
    );
    await main.getByRole('button', { name: 'Open a pull request with the pipeline' }).click();
    expect((await opened).status()).toBe(200);
    const status = main.getByRole('status');
    await expect(status).toContainText('Pull request opened with the pipeline.');
    await expect(status.getByRole('link', { name: 'Open it on Bitbucket' })).toHaveAttribute(
      'href',
      `https://bitbucket.org/acme/pipeline-demo-${tag}/pull-requests/1`
    );
    await shot(page, testInfo, 'pipeline-builder-01-desktop');

    // A change goes to the same pull request; main is untouched until it merges.
    await production.getByRole('button', { name: new RegExp(`^${deployName}`) }).click();
    await editor.getByRole('textbox', { name: 'service_name' }).fill('billing-api');
    await main.getByRole('button', { name: 'Update the pull request' }).click();
    await expect(status).toContainText('The pull request has the new file.');
    await expect(found).toContainText('No bitbucket-pipelines.yml on main yet');

    // At a phone's width: nothing scrolls sideways.
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(production).toBeVisible();
    const overflow = await page.evaluate(() => {
      const frame = document.querySelector('main .overflow-y-auto');
      return Math.max(
        document.documentElement.scrollWidth - document.documentElement.clientWidth,
        frame ? frame.scrollWidth - frame.clientWidth : 0
      );
    });
    expect(overflow).toBeLessThanOrEqual(0);
    // The app scrolls inside its frame: the top, then the checks and the button.
    await shot(page, testInfo, 'pipeline-builder-02-phone', false);
    await main.getByRole('button', { name: 'Update the pull request' }).scrollIntoViewIfNeeded();
    await shot(page, testInfo, 'pipeline-builder-03-phone-checks', false);
  } finally {
    for (const id of blockIds) await page.request.delete(`/api/admin/ci-blocks/${id}`);
    if (targetId) await page.request.delete(`/api/admin/ci-targets/${targetId}`);
  }
});
