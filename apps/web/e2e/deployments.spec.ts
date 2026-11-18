/**
 * Deployments, end to end in a browser, on a Bitbucket repository: a code
 * project's pipeline built from blocks goes into a pull request (which is
 * how Renkei learns the repository's UUID), then its deploy steps report
 * as a real step would — with the OpenID Connect token Bitbucket gives the
 * step, here signed by the stub's issuer — production first, then dev.
 * The Deployments page, reached from the sidebar, shows what runs where,
 * that production is behind dev and ready to promote, and the newest
 * deployments; the app's page shows the commits merging brings, opens the
 * promotion's pull request, asks before merging it, merges it, and shows
 * production caught up once its pipeline reports. A report without a
 * host's token is refused. The pages fit a phone.
 *
 * Bitbucket is the sandbox stub's (`acme/pipeline-demo-*`, and its OIDC
 * issuer at the workspace's `pipelines-config/identity/oidc`). Where the
 * rules went: the cells, notes, banner, promotion and merge question —
 * deployments-page.model.test.ts and deployment-app.model.test.ts;
 * verifying tokens and recording reports — lib/ci/deployment-reports.test.ts;
 * promoting on the host — lib/ci/deployments.test.ts; the report step a
 * pipeline runs — packages/ci-blocks report.test.ts.
 *
 * The blocks and the target are organization-wide: they carry this run's
 * tag and go again through the admin routes at the end. The person is
 * fresh, so the Deployments page shows their one project.
 */

import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { APIRequestContext, Page, TestInfo } from '@playwright/test';
import { test, expect } from './fixtures';
import { SANDBOX_STUB_URL } from './constants';
import { connectBitbucket, createCodeProject, prepareCodeHost } from './support/code-host';

test.use({ roles: ['renkei-user', 'renkei-operator'] });

const DEV_COMMIT = '8e41c2a9f0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5';
const PROD_COMMIT = '3b07d9f9f0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5';

async function shot(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  await page.screenshot({
    path: path.join(
      import.meta.dirname,
      '..',
      'test-results',
      'screens',
      testInfo.project.name,
      `${name}.png`
    ),
    fullPage: false,
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

test('deployments: reports show what runs where, and promoting merges @smoke', async ({
  page,
  request,
  person: _person,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== 'desktop-light',
    'One pass is enough: the pages are drawn by their models.'
  );
  const tag = `${testInfo.project.name}-${randomUUID().slice(0, 6)}`;
  const name = `Deploy demo (${tag})`;
  const repo = `acme/pipeline-demo-${tag}`;
  const target = `deploy-${tag}`;
  const blockIds: string[] = [];
  let targetId: string | null = null;

  await prepareCodeHost(request);
  await connectBitbucket(page);
  try {
    for (const block of [
      {
        key: `build-${tag}`,
        name: `Node: build ${tag}`,
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
        key: `ship-${tag}`,
        name: `Ship ${tag}`,
        kind: 'deploy',
        definition: {
          kind: 'deploy',
          runsOn: { type: 'target' },
          inputs: [],
          variables: [],
          consumes: ['dist'],
          produces: [],
          caches: [],
          commands: './ship.sh',
        },
      },
    ]) {
      const id = await created(page.request, '/api/admin/ci-blocks', {
        ...block,
        description: null,
      });
      blockIds.push(id);
      expect((await page.request.post(`/api/admin/ci-blocks/${id}/publish`)).ok()).toBe(true);
    }
    targetId = await created(page.request, '/api/admin/ci-targets', {
      name: target,
      description: null,
      labels: { bitbucket: ['self.hosted', target], github: [] },
    });

    // The project, its pipeline, and the pull request that carries it.
    const projectId = await createCodeProject(page.request, {
      name,
      repository: repo,
      branch: 'main',
    });
    const steps = [
      { block: `build-${tag}`, version: 1, inputs: {} },
      { block: `ship-${tag}`, version: 1, inputs: {}, target },
    ];
    const spec = {
      checks: [steps[0]],
      environments: [
        { name: 'dev', branch: 'develop', steps },
        { name: 'production', branch: 'main', steps },
      ],
    };
    const opened = await page.request.post(
      `/api/code/projects/${projectId}/pipeline-builder/pull-request`,
      {
        data: { spec },
      }
    );
    expect(opened.ok(), await opened.text()).toBe(true);

    // The deploy steps report, each with the token Bitbucket gives its step.
    const repository: unknown = await (
      await request.get(`${SANDBOX_STUB_URL}/bitbucket/2.0/repositories/${repo}`)
    ).json();
    const repositoryUuid = field(repository, 'uuid');
    expect(typeof repositoryUuid).toBe('string');
    const stepToken = async (branchName: string) =>
      String(
        field(
          await (
            await request.post(`${SANDBOX_STUB_URL}/e2e/bitbucket-step-token`, {
              data: { repositoryUuid, branchName },
            })
          ).json(),
          'token'
        )
      );
    const report = async (environment: string, status: string, commit: string, run: string) => {
      const branch = environment === 'dev' ? 'develop' : 'main';
      const response = await page.request.post('/api/deployments/report', {
        headers: { Authorization: `Bearer ${await stepToken(branch)}` },
        data: { environment, status, commit, branch, run, target, detail: '' },
      });
      expect(response.status(), await response.text()).toBe(200);
    };
    await report('production', 'started', PROD_COMMIT, '90');
    await report('production', 'succeeded', PROD_COMMIT, '90');
    await report('dev', 'started', DEV_COMMIT, '101');
    await report('dev', 'succeeded', DEV_COMMIT, '101');
    // Without a host's token, nothing is taken.
    const refused = await page.request.post('/api/deployments/report', {
      headers: { Authorization: 'Bearer not-a-token' },
      data: { environment: 'dev', status: 'succeeded', commit: DEV_COMMIT },
    });
    expect(refused.status()).toBe(401);

    // The Deployments page, from the sidebar.
    await page.goto('/');
    await page.getByRole('link', { name: 'Deployments', exact: true }).first().click();
    const main = page.getByRole('main');
    await expect(main.getByRole('heading', { name: 'Deployments', level: 1 })).toBeVisible();
    const app = main.getByRole('article', { name });
    await expect(app).toContainText('Dev · develop', { timeout: 30_000 });
    await expect(app).toContainText('8e41c2a');
    await expect(app).toContainText('Production · main');
    await expect(app).toContainText('3b07d9f');
    await expect(app).toContainText('Behind Dev');
    await expect(app).toContainText(`target ${target}`);
    const ready = main.getByRole('region', { name: 'Ready to promote' });
    await expect(ready).toContainText(`${name}: Production runs 3b07d9f, Dev runs 8e41c2a.`);
    await expect(main.getByRole('region', { name: 'Recent deployments' })).toContainText(
      `${name} 8e41c2a → Dev`
    );
    await shot(page, testInfo, 'deployments-01-overview');

    // The app's page: what merging brings, the pull request, the merge.
    await ready.getByRole('link', { name: 'Review and promote' }).click();
    await expect(main.getByRole('heading', { name, level: 1 })).toBeVisible();
    const promotion = main.getByRole('region', {
      name: 'Promote to Production: merge develop into main',
    });
    await expect(promotion).toContainText('merging brings 2 commits from develop');
    await expect(promotion).toContainText('Show the intake status on the case page');
    await promotion.getByRole('button', { name: 'Open a pull request: develop → main' }).click();
    const status = main.getByRole('status');
    await expect(status).toContainText(/Pull request #\d+ opened\. Merging it deploys\./);
    await promotion.getByRole('button', { name: 'Merge to main' }).click();
    const question = promotion.getByRole('alertdialog', { name: 'Merge to deploy' });
    await expect(question).toContainText(
      /Merge pull request #\d+ into main\? The pipeline on main deploys Production/
    );
    await shot(page, testInfo, 'deployments-02-promote');
    await question.getByRole('button', { name: 'Merge and deploy' }).click();
    await expect(status).toContainText(/Merged #\d+\. The pipeline on main deploys production/);
    await expect(promotion).toContainText('main has everything develop has: nothing to promote.');

    // Production's pipeline reports, and it has caught up.
    await report('production', 'succeeded', DEV_COMMIT, '91');
    await page.reload();
    const production = main.getByRole('article', { name: 'Production' });
    await expect(production).toContainText('8e41c2a', { timeout: 30_000 });
    await expect(production).toContainText('Healthy');
    await expect(production).not.toContainText('Behind');
    await expect(main.getByRole('region', { name: 'History' })).toContainText('Pipelines #91');

    // At a phone's width: nothing scrolls sideways, on either page.
    await page.setViewportSize({ width: 390, height: 844 });
    const overflow = () =>
      page.evaluate(() => {
        const frame =
          document.querySelector('main .overflow-y-auto') ?? document.querySelector('main');
        return Math.max(
          document.documentElement.scrollWidth - document.documentElement.clientWidth,
          frame ? frame.scrollWidth - frame.clientWidth : 0
        );
      });
    await expect(production).toBeVisible();
    expect(await overflow()).toBeLessThanOrEqual(0);
    await shot(page, testInfo, 'deployments-03-app-phone');
    await page.goto('/deployments');
    await expect(main.getByRole('article', { name })).toBeVisible({ timeout: 30_000 });
    expect(await overflow()).toBeLessThanOrEqual(0);
    await shot(page, testInfo, 'deployments-04-overview-phone');
  } finally {
    for (const id of blockIds) await page.request.delete(`/api/admin/ci-blocks/${id}`);
    if (targetId) await page.request.delete(`/api/admin/ci-targets/${targetId}`);
  }
});
