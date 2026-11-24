/**
 * A branch whose pipeline was written outside Renkei, end to end in a
 * browser, on a Bitbucket repository: the Pipeline tab opens on the
 * `bitbucket-pipelines.yml` that is on the branch, as it is, rather than
 * on the builder; the assistant (the stub, on the project's own model)
 * reads the repository and proposes the file edited, which goes into the
 * editor and is committed to the branch by the person; the report step is
 * taken and copied, and a deploy step that carries it (signed as
 * Bitbucket signs a step's) shows what runs in the environment though no
 * pipeline was built here; and building from blocks is one explicit
 * choice away, with the way back to the file.
 *
 * Bitbucket is the sandbox stub's (`acme/pipeline-demo-*`: branches, its
 * files by branch, and its OIDC issuer). Where the rules went: which file
 * is open, the edit and what Commit sends — existing-pipeline.model.test.ts;
 * when the tab opens on the file — pipeline-builder.model.test.ts; the
 * assistant's file and what it refuses — lib/ci/pipeline-assistant.test.ts;
 * the report step and how a report finds its project —
 * lib/ci/report-step.test.ts and lib/ci/deployment-reports.test.ts.
 *
 * The model is organization-wide: it carries this run's tag and goes
 * again through the admin route at the end.
 */

import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Page, TestInfo } from '@playwright/test';
import { test, expect } from './fixtures';
import { SANDBOX_STUB_URL } from './constants';
import {
  assignEnvironments,
  connectBitbucket,
  createCodeProject,
  pipelineTab,
  prepareCodeHost,
} from './support/code-host';
import { addStubModel, scripted } from './support/stub-model';

test.use({ roles: ['renkei-user', 'renkei-operator'] });

const COMMIT = '5c1d9e7af0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5';
const BY_HAND = [
  'image: node:20',
  '',
  'pipelines:',
  '  branches:',
  '    main:',
  '      - step:',
  '          name: Deploy',
  '          deployment: production',
  '          script:',
  '            - npm ci',
  '            - ./deploy.sh',
  '',
].join('\n');
const EDITED = BY_HAND.replace(
  '            - npm ci\n',
  '            - npm ci\n            - npm test\n'
);

function field(body: unknown, name: string): unknown {
  return typeof body === 'object' && body !== null && name in body
    ? Reflect.get(body, name)
    : undefined;
}

/** The page scrolls inside the app's frame: grow the window to what it holds, then put it back. */
async function shot(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  const size = page.viewportSize();
  if (size) {
    const height = await page.evaluate(() => {
      const frame = document.querySelector('main .overflow-y-auto');
      return frame ? frame.scrollHeight + (window.innerHeight - frame.clientHeight) : 0;
    });
    await page.setViewportSize({
      width: size.width,
      height: Math.min(Math.max(height, 900), 2600),
    });
  }
  await page.screenshot({
    path: path.join(
      import.meta.dirname,
      '..',
      'test-results',
      'screens',
      testInfo.project.name,
      `${name}.png`
    ),
  });
  if (size) await page.setViewportSize(size);
}

test('a pipeline written elsewhere: the tab opens on its file, the assistant edits it, it reports what it deploys', async ({
  page,
  request,
  person: _person,
}, testInfo) => {
  // A dev server compiles each route the first time it is asked for one.
  test.setTimeout(240_000);
  const tag = `${testInfo.project.name}-${randomUUID().slice(0, 6)}`;
  const repo = `acme/pipeline-demo-existing-${tag}`;
  let modelId: string | null = null;

  await prepareCodeHost(request);
  await connectBitbucket(page);
  try {
    const projectId = await createCodeProject(page.request, {
      name: `Existing pipeline (${tag})`,
      repository: repo,
      branch: 'main',
    });
    await assignEnvironments(page.request, projectId);
    modelId = await addStubModel(page.request, tag);
    const onModel = await page.request.patch(`/api/chat/projects/${projectId}`, {
      data: { llmModelId: modelId },
    });
    expect(onModel.ok(), await onModel.text()).toBe(true);
    // The pipeline as someone wrote it in another editor: on the branch, not in Renkei.
    const written = await page.request.put(
      `/api/code/projects/${projectId}/pipelines/config-file?branch=main`,
      { data: { text: BY_HAND, message: 'Add the pipeline' } }
    );
    expect(written.ok(), await written.text()).toBe(true);

    // The Pipeline tab opens on that file, not on a suggestion to replace it.
    await page.goto(pipelineTab(projectId));
    const main = page.getByRole('main');
    const file = main.getByRole('region', { name: 'The pipeline on main' });
    await expect(file).toContainText('Not built in Renkei', { timeout: 30_000 });
    await expect(file.getByLabel('bitbucket-pipelines.yml as it is on main')).toContainText(
      '- ./deploy.sh',
      { timeout: 30_000 }
    );
    await expect(main.getByRole('region', { name: 'Found in this repository' })).toHaveCount(0);
    await expect(
      main.getByRole('button', { name: 'Open a pull request with the pipeline' })
    ).toHaveCount(0);
    await shot(page, testInfo, 'existing-pipeline-01-file');

    // The assistant works on the file: it reads the repository and proposes it edited.
    await file.getByRole('button', { name: 'Ask the assistant to change it' }).click();
    const panel = page.getByRole('dialog', { name: 'Pipeline assistant' });
    await expect(panel).toContainText('edits bitbucket-pipelines.yml as it is');
    await panel.getByLabel('Ask the assistant').fill(
      scripted('Run the tests before it deploys.', [
        { tools: [{ name: 'read_file', input: { path: 'README.md' } }] },
        {
          tools: [
            {
              name: 'propose_file',
              input: { summary: 'Runs npm test before the deploy.', text: EDITED },
            },
          ],
        },
        { text: 'The tests now run before the deploy step’s script deploys.' },
      ])
    );
    const asked = page.waitForRequest(
      (r) => r.url().includes('/pipeline-builder/assistant?branch=main') && r.method() === 'POST'
    );
    await panel.getByRole('button', { name: 'Ask' }).click();
    // The question carries the file on screen, not a pipeline of blocks.
    expect((await asked).postDataJSON().file).toEqual({
      name: 'bitbucket-pipelines.yml',
      text: BY_HAND,
    });
    const proposed = panel.getByRole('group', { name: 'Proposed file' });
    await expect(proposed).toContainText('Runs npm test before the deploy.', { timeout: 30_000 });
    await proposed.getByRole('button', { name: 'Put it in the editor' }).click();
    await panel.getByRole('button', { name: 'Collapse the Pipeline assistant' }).click();

    // It is in the editor, to be looked over; the person commits it to the branch.
    const editor = file.getByRole('form', { name: 'Edit the pipeline file' });
    await expect(editor.getByLabel('bitbucket-pipelines.yml')).toHaveValue(EDITED);
    await shot(page, testInfo, 'existing-pipeline-02-proposal-in-editor');
    const committed = page.waitForRequest(
      (r) => r.url().includes('/pipelines/config-file?branch=main') && r.method() === 'PUT'
    );
    await editor.getByRole('button', { name: 'Commit' }).click();
    expect((await committed).postDataJSON()).toEqual({
      text: EDITED,
      message: 'Update bitbucket-pipelines.yml',
    });
    await expect(file.getByRole('status')).toContainText(
      'Committed bitbucket-pipelines.yml to main.'
    );
    await expect(file.getByLabel('bitbucket-pipelines.yml as it is on main')).toContainText(
      '- npm test'
    );

    // The report step, to copy into the file: taking it is what lets its reports in.
    const report = main.getByRole('region', { name: 'Show what it deploys' });
    await report.getByRole('button', { name: 'Get the report step' }).click();
    const snippet = report.getByLabel('The report step for production');
    await expect(snippet).toContainText('deployment: production');
    await expect(snippet).toContainText('oidc: true');
    await expect(snippet).toContainText('/api/deployments/report');
    await shot(page, testInfo, 'existing-pipeline-03-report-step');

    // A deploy step carrying it reports, signed as Bitbucket signs a step's token.
    const repository: unknown = await (
      await request.get(`${SANDBOX_STUB_URL}/bitbucket/2.0/repositories/${repo}`)
    ).json();
    const token = String(
      field(
        await (
          await request.post(`${SANDBOX_STUB_URL}/e2e/bitbucket-step-token`, {
            data: { repositoryUuid: field(repository, 'uuid'), branchName: 'main' },
          })
        ).json(),
        'token'
      )
    );
    for (const status of ['started', 'succeeded']) {
      const response = await page.request.post('/api/deployments/report', {
        headers: { Authorization: `Bearer ${token}` },
        data: { environment: 'production', status, commit: COMMIT, branch: 'main', run: '7' },
      });
      expect(response.status(), await response.text()).toBe(200);
    }
    await page.reload();
    const production = main.getByRole('region', { name: 'production', exact: true });
    await expect(production).toContainText('Healthy', { timeout: 30_000 });
    await expect(production).toContainText('5c1d9e7');
    // Still on the file: nothing was built or saved here.
    await expect(file).toContainText('Not built in Renkei');

    // Building from blocks is an explicit choice, said for what it does, with the way back.
    const build = main.getByRole('region', { name: 'Or build it from blocks' });
    await expect(build).toContainText('merging it replaces the file here');
    await build.getByRole('button', { name: 'Replace it with one built from blocks' }).click();
    await expect(main.getByRole('region', { name: 'Found in this repository' })).toBeVisible();
    await expect(main.getByText('already has a pipeline that was not built here')).toBeVisible();
    await shot(page, testInfo, 'existing-pipeline-04-builder');
    await main.getByRole('button', { name: 'See the file on the branch' }).click();
    await expect(file.getByLabel('bitbucket-pipelines.yml as it is on main')).toBeVisible();
  } finally {
    if (modelId) await page.request.delete(`/api/admin/llm-models/${modelId}`);
  }
});
