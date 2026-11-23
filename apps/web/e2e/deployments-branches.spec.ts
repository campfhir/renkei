/**
 * An app's branches under Deployments, end to end in a browser, on a
 * Bitbucket repository: every branch — the environments' and a feature
 * branch — with the environment it deploys and its newest run; "Run
 * checks" on the feature branch starts the pipeline's checks there through
 * the real route and the stand-in host (Bitbucket's custom pipeline
 * `checks`); "Redeploy Production" asks first, then starts production's
 * deploy on main (`deploy-production`); the list fits a phone.
 *
 * Bitbucket is the sandbox stub's (`acme/pipeline-demo-*`: its branches,
 * and the runs it seeds and starts). Where the rules went: the rows, what
 * an editor can start, the question before a redeploy —
 * deployment-app.model.test.ts; the branch order and which run may start
 * on which branch — lib/ci/deployments.test.ts; the custom pipelines the
 * file declares — packages/ci-blocks pipeline.test.ts.
 *
 * The block is organization-wide: it carries this run's tag and goes
 * again through the admin route at the end.
 */

import { randomUUID } from 'node:crypto';
import type { Page } from '@playwright/test';
import { isRecord } from '@renkei/guards';
import { test, expect } from './fixtures';
import { SANDBOX_STUB_URL } from './constants';
import { connectBitbucket, createCodeProject, prepareCodeHost } from './support/code-host';

test.use({ roles: ['renkei-user', 'renkei-operator'] });

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

test('deployments: every branch with its newest run; run the checks on one, redeploy an environment', async ({
  page,
  request,
  person: _person,
}, testInfo) => {
  // A dev server compiles each route the first time it is asked for one.
  test.setTimeout(180_000);
  const tag = `${testInfo.project.name}-${randomUUID().slice(0, 6)}`;
  const repo = `acme/pipeline-demo-${tag}`;
  let blockId: string | null = null;

  await prepareCodeHost(request);
  await connectBitbucket(page);
  try {
    const made = await page.request.post('/api/admin/ci-blocks', {
      data: {
        key: `build-${tag}`,
        name: `Node: build ${tag}`,
        kind: 'build',
        description: null,
        definition: {
          kind: 'build',
          runsOn: { type: 'hosted', image: 'node:22' },
          inputs: [],
          variables: [],
          consumes: [],
          produces: [],
          caches: [],
          commands: 'npm ci && npm run build',
        },
      },
    });
    expect(made.status(), await made.text()).toBe(201);
    const madeBody: unknown = await made.json();
    blockId =
      typeof madeBody === 'object' && madeBody !== null && 'id' in madeBody
        ? String(madeBody.id)
        : null;
    expect((await page.request.post(`/api/admin/ci-blocks/${blockId}/publish`)).ok()).toBe(true);

    // The project and its pipeline: checks, then dev from develop and production from main.
    const projectId = await createCodeProject(page.request, {
      name: `Branches demo (${tag})`,
      repository: repo,
      branch: 'main',
    });
    const build = { block: `build-${tag}`, version: 1, inputs: {} };
    const saved = await page.request.put(`/api/code/projects/${projectId}/pipeline-builder`, {
      data: {
        spec: {
          checks: [build],
          environments: [
            { name: 'dev', branch: 'develop', steps: [build] },
            { name: 'production', branch: 'main', steps: [build] },
          ],
        },
      },
    });
    expect(saved.ok(), await saved.text()).toBe(true);

    // A feature branch someone pushed, on the host.
    const pushed = await request.post(
      `${SANDBOX_STUB_URL}/bitbucket/2.0/repositories/${repo}/refs/branches`,
      { data: { name: 'feature/intake-form', target: { hash: '0f00dbab0000' } } }
    );
    expect(pushed.status(), await pushed.text()).toBe(201);
    const newestRun = async () => {
      const listed: unknown = await (
        await request.get(`${SANDBOX_STUB_URL}/bitbucket/2.0/repositories/${repo}/pipelines`)
      ).json();
      const values = isRecord(listed) && Array.isArray(listed.values) ? listed.values : [];
      const newest: unknown = values[0];
      return isRecord(newest) ? newest.target : undefined;
    };

    // Every branch: the environments' first, the feature branch too.
    await page.goto(`/deployments/${projectId}`);
    const main = page.getByRole('main');
    const branches = main.getByRole('region', { name: 'Branches' });
    await expect(branches).toBeVisible({ timeout: 30_000 });
    const rows = branches.getByRole('listitem');
    await expect(rows.nth(0)).toHaveAccessibleName('Branch develop');
    await expect(rows.nth(0)).toContainText('deploys Dev');
    await expect(rows.nth(1)).toHaveAccessibleName('Branch main');
    await expect(rows.nth(1)).toContainText('deploys Production');
    await expect(rows.nth(1)).toContainText('Passed');
    const feature = branches.getByRole('listitem', { name: 'Branch feature/intake-form' });
    await expect(feature).toContainText('No runs');
    await expect(feature.getByRole('button', { name: /^Redeploy/ })).toHaveCount(0);

    // The checks on the feature branch, straight away.
    const asked = page.waitForRequest(
      (r) => r.url().endsWith(`/api/deployments/${projectId}/run`) && r.method() === 'POST'
    );
    await feature.getByRole('button', { name: 'Run checks' }).click();
    expect((await asked).postDataJSON()).toEqual({ branch: 'feature/intake-form', run: 'checks' });
    const started = main.getByRole('status').filter({ hasText: 'Started the checks' });
    await expect(started).toHaveText(
      /Started the checks on feature\/intake-form\.\s*See the run on Bitbucket/
    );
    await expect(started.getByRole('link', { name: 'See the run on Bitbucket' })).toHaveAttribute(
      'href',
      /\/pipelines\/results\/\d+$/
    );
    expect(await newestRun()).toMatchObject({
      ref_name: 'feature/intake-form',
      selector: { type: 'custom', pattern: 'checks' },
    });

    // Production redeploys from main, asked first.
    await rows.nth(1).getByRole('button', { name: 'Redeploy Production' }).click();
    const question = branches.getByRole('alertdialog', { name: 'Redeploy' });
    await expect(question).toContainText(
      'Redeploy Production from main? The pipeline deploys what main has now.'
    );
    await question.getByRole('button', { name: 'Redeploy' }).click();
    await expect(question).toBeHidden();
    await expect(main.getByRole('status').filter({ hasText: 'Started redeploying' })).toContainText(
      'Started redeploying Production from main.'
    );
    expect(await newestRun()).toMatchObject({
      ref_name: 'main',
      selector: { type: 'custom', pattern: 'deploy-production' },
    });

    // The list fits a phone.
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(feature.getByRole('button', { name: 'Run checks' })).toBeVisible();
    await expectNoHorizontalOverflow(page);
  } finally {
    if (blockId) await page.request.delete(`/api/admin/ci-blocks/${blockId}`);
  }
});
