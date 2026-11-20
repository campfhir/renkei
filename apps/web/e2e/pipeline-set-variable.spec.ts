/**
 * "Set it" on a missing variable, end to end in a browser, on a Bitbucket
 * repository: the pipeline builder names a secret its block reads that is
 * not set for production; its "Set for production" opens the Runs &
 * variables page with Production's box open on `secret DEPLOY_TOKEN=`,
 * focused, the cursor after the `=`; typing the value and saving sets it
 * through the real route and the stand-in host; back on the builder it is
 * missing only for pull requests.
 *
 * Where the rules went: which links a check has —
 * pipeline-builder.model.test.ts; which box opens, the line added or
 * found and where the cursor goes — pipelines-page.model.test.ts and
 * lib/code/pipeline-variables-text.test.ts; the check itself —
 * packages/ci-blocks pipeline.test.ts.
 *
 * The block is organization-wide: it carries this run's tag and goes
 * again through the admin route at the end.
 */

import { randomUUID } from 'node:crypto';
import { test, expect } from './fixtures';
import { connectBitbucket, createCodeProject, prepareCodeHost } from './support/code-host';

test.use({ roles: ['renkei-user', 'renkei-operator'] });

test('pipeline builder: "Set it" opens the variable’s line ready for its value', async ({
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
    const staged = await page.request.put(`/api/code/projects/${projectId}/pipeline-builder`, {
      data: {
        spec: {
          checks: [build],
          environments: [{ name: 'production', branch: 'main', steps: [build] }],
        },
      },
    });
    expect(staged.ok(), await staged.text()).toBe(true);

    // The builder says where it is missing, with a "Set" for each place.
    await page.goto(`/deployments/${projectId}/pipeline`);
    const main = page.getByRole('main');
    const checks = main.getByRole('region', { name: 'Before it runs' });
    await expect(checks).toContainText('DEPLOY_TOKEN is not set for pull requests, production.', {
      timeout: 30_000,
    });
    await checks.getByRole('link', { name: 'Set for production' }).click();

    // Production's box, open on the secret's line, the cursor after the `=`.
    await expect(page).toHaveURL(
      new RegExp(`/deployments/${projectId}/runs\\?set=DEPLOY_TOKEN&in=production&secret=1$`)
    );
    const production = main.getByRole('region', { name: 'Production' });
    const box = production
      .getByRole('form', { name: 'Edit Production' })
      .getByLabel('Production as text');
    await expect(box).toHaveValue('secret DEPLOY_TOKEN=', { timeout: 30_000 });
    await expect(box).toBeFocused();
    expect(
      await box.evaluate((el: HTMLTextAreaElement) => [el.selectionStart, el.selectionEnd])
    ).toEqual([20, 20]);

    // Just the value typed, then saved.
    await page.keyboard.type('s3cret-value');
    await expect(box).toHaveValue('secret DEPLOY_TOKEN=s3cret-value');
    await production.getByRole('button', { name: 'Save' }).click();
    await expect(production.getByRole('status')).toContainText('added DEPLOY_TOKEN');
    await expect(production).toContainText('DEPLOY_TOKEN');
    await expect(production).toContainText('Secured');

    // Back on the builder, only pull requests still lack it.
    await page.goto(`/deployments/${projectId}/pipeline`);
    await expect(checks).toContainText('DEPLOY_TOKEN is not set for pull requests.', {
      timeout: 30_000,
    });
    await expect(checks.getByRole('link', { name: 'Set it' })).toHaveAttribute(
      'href',
      `/deployments/${projectId}/runs?set=DEPLOY_TOKEN&secret=1`
    );
  } finally {
    if (blockId) await page.request.delete(`/api/admin/ci-blocks/${blockId}`);
  }
});
