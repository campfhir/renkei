/**
 * "Set it" on a missing variable, end to end in a browser, on a Bitbucket
 * repository: a branch's pipeline builder names a secret its block reads
 * that is not set for production; its "Set for production" opens the
 * Variables tab with a locked row for DEPLOY_TOKEN in production's set,
 * the cursor in its value; typing the value and saving sets it through
 * the real route and the stand-in host; back on the builder it is missing
 * only for pull requests, whose "Set it" names the repository's set.
 *
 * Where the rules went: which links a check has —
 * pipeline-builder.model.test.ts; the row added and where the cursor goes
 * — variables-editor.model.test.ts; the check itself — packages/ci-blocks
 * pipeline.test.ts.
 *
 * The block is organization-wide: it carries this run's tag and goes
 * again through the admin route at the end.
 */

import { randomUUID } from 'node:crypto';
import { test, expect } from './fixtures';
import {
  assignEnvironments,
  connectBitbucket,
  createCodeProject,
  pipelineTab,
  prepareCodeHost,
} from './support/code-host';

test.use({ roles: ['renkei-user', 'renkei-operator'] });

test('pipeline builder: "Set it" opens the variable’s row ready for its value', async ({
  page,
  person: _person,
}, testInfo) => {
  // A dev server compiles each route the first time it is asked for one.
  test.setTimeout(180_000);
  const tag = `${testInfo.project.name}-${randomUUID().slice(0, 6)}`;
  let blockId: string | null = null;

  await prepareCodeHost(page.request);
  await connectBitbucket(page);
  try {
    // A published block that reads a secret, as an operator makes it.
    const made = await page.request.post('/api/admin/ci-blocks', {
      data: {
        key: `build-${tag}`,
        name: `Build ${tag}`,
        kind: 'build',
        description: null,
        definition: {
          kind: 'build',
          runsOn: { type: 'hosted', image: 'node:22' },
          inputs: [],
          variables: [{ name: 'DEPLOY_TOKEN', secured: true }],
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
    expect(blockId).not.toBeNull();
    const published = await page.request.post(`/api/admin/ci-blocks/${blockId}/publish`);
    expect(published.ok(), await published.text()).toBe(true);

    // A project on a repository of its own, the block on pull requests and production.
    const projectId = await createCodeProject(page.request, {
      name: `Set variable (${tag})`,
      repository: `acme/set-variable-${tag}`,
      branch: 'main',
    });
    const build = { block: `build-${tag}`, version: 1, inputs: {} };
    await assignEnvironments(page.request, projectId);
    const staged = await page.request.put(
      `/api/code/projects/${projectId}/pipeline-builder?branch=main`,
      {
        data: {
          spec: {
            checks: [build],
            environments: [{ name: 'production', branch: 'main', steps: [build] }],
          },
        },
      }
    );
    expect(staged.ok(), await staged.text()).toBe(true);

    // The builder says where it is missing, with a "Set" for each place.
    await page.goto(pipelineTab(projectId));
    const main = page.getByRole('main');
    const checks = main.getByRole('region', { name: 'Before it runs' });
    await expect(checks).toContainText('DEPLOY_TOKEN is not set for pull requests, production.', {
      timeout: 30_000,
    });
    await checks.getByRole('link', { name: 'Set for production' }).click();

    // The Variables tab, production's set: a locked row, the cursor in its value.
    await expect(page).toHaveURL(/tab=variables&set=DEPLOY_TOKEN&scope=environment&secret=1$/);
    const production = main.getByTestId('variables-environment-production');
    const value = production.getByLabel('Value of DEPLOY_TOKEN');
    await expect(value).toBeFocused({ timeout: 30_000 });
    await expect(
      production.getByRole('button', { name: 'DEPLOY_TOKEN is a secret' })
    ).toHaveAttribute('aria-pressed', 'true');

    // Just the value typed, then saved.
    await page.keyboard.type('s3cret-value');
    await production.getByRole('button', { name: 'Save' }).click();
    await expect(production.getByRole('status')).toContainText('Saved: added DEPLOY_TOKEN.');
    // Saved as a secret: its value is not on the page any more.
    await expect(value).toHaveValue('');
    await expect(value).toHaveAttribute('placeholder', 'Secret — type to replace');

    // Back on the builder, only pull requests still lack it.
    await page.goto(pipelineTab(projectId));
    await expect(checks).toContainText('DEPLOY_TOKEN is not set for pull requests.', {
      timeout: 30_000,
    });
    await expect(checks.getByRole('link', { name: 'Set it' })).toHaveAttribute(
      'href',
      `/code/${projectId}/environments?env=production&branch=main&tab=variables&set=DEPLOY_TOKEN&scope=repository&secret=1`
    );
  } finally {
    if (blockId) await page.request.delete(`/api/admin/ci-blocks/${blockId}`);
  }
});
