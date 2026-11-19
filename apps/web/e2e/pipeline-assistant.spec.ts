/**
 * The pipeline builder's assistant, end to end in a browser, on a
 * Bitbucket repository: an operator asks it to tailor the pipeline; the
 * assistant opens from the app's floating dock; the question reaches the server with the pipeline on screen; the model (the
 * stub, on the project's own model) lists and reads the repository
 * through the stand-in host and proposes a pipeline with a block of the
 * project's own; applied, the block is in its row and in the file the
 * builder writes, and Save keeps it; asked to make it reusable, it
 * proposes a building block that saves as a draft in the organization's
 * catalogue; and the panel fits a phone.
 *
 * Where the rules went: the conversation, proposals and what each button
 * sends — pipeline-assistant.model.test.ts; the project's blocks in the
 * rows, picker and file — pipeline-builder.model.test.ts; the tool loop
 * and what it refuses — lib/ci/pipeline-assistant.test.ts; project blocks
 * in the file — packages/ci-blocks pipeline.test.ts.
 *
 * The block, the model and the drafted building block are
 * organization-wide: they carry this run's tag and go again through the
 * admin routes at the end.
 */

import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { APIRequestContext, Page, TestInfo } from '@playwright/test';
import { test, expect } from './fixtures';
import { connectBitbucket, createCodeProject, prepareCodeHost } from './support/code-host';
import { addStubModel, scripted } from './support/stub-model';

test.use({ roles: ['renkei-user', 'renkei-operator'] });

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
    fullPage: true,
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

test('pipeline assistant: tailor a block to the source, apply it, make it reusable', async ({
  page,
  request,
  person: _person,
}, testInfo) => {
  test.setTimeout(180_000);
  const tag = `${testInfo.project.name}-${randomUUID().slice(0, 6)}`;
  const testKey = `test-${tag}`;
  const ownKey = `build-billing-${tag}`;
  const reusableKey = `node-pnpm-build-${tag}`;
  const blockIds: string[] = [];
  let modelId: string | null = null;

  await prepareCodeHost(request);
  await connectBitbucket(page);
  try {
    // One published organization block, as an operator makes it.
    const testId = await created(page.request, '/api/admin/ci-blocks', {
      key: testKey,
      name: `Test ${tag}`,
      description: null,
      kind: 'test',
      definition: {
        kind: 'test',
        runsOn: { type: 'hosted', image: 'node:22' },
        inputs: [],
        variables: [],
        consumes: [],
        produces: [],
        caches: [],
        commands: 'npm ci && npm test',
      },
    });
    blockIds.push(testId);
    const published = await page.request.post(`/api/admin/ci-blocks/${testId}/publish`);
    expect(published.ok(), await published.text()).toBe(true);

    // A project with its pipeline saved, answering on the stub model.
    const projectId = await createCodeProject(page.request, {
      name: `Assistant demo (${tag})`,
      repository: `acme/pipeline-assist-${tag}`,
      branch: 'main',
    });
    modelId = await addStubModel(page.request, tag);
    const onModel = await page.request.patch(`/api/chat/projects/${projectId}`, {
      data: { llmModelId: modelId },
    });
    expect(onModel.ok(), await onModel.text()).toBe(true);
    const check = { block: testKey, version: 1, inputs: {} };
    const staged = await page.request.put(`/api/code/projects/${projectId}/pipeline-builder`, {
      data: { spec: { checks: [check], environments: [] } },
    });
    expect(staged.ok(), await staged.text()).toBe(true);

    await page.goto(`/deployments/${projectId}/pipeline`);
    const main = page.getByRole('main');
    // The assistant floats in the dock, collapsed until its button is pressed.
    const cta = page.getByRole('button', { name: 'Open the Pipeline assistant' });
    await expect(main.getByRole('region', { name: 'Found in this repository' })).toBeVisible({
      timeout: 30_000,
    });
    await cta.click();
    const panel = page.getByRole('dialog', { name: 'Pipeline assistant' });
    await expect(panel).toContainText('It reads this repository’s source');

    // --- Tailor it: the model reads the repository, then proposes. ---
    const ownBlock = {
      key: ownKey,
      name: `Build billing ${tag}`,
      description: 'pnpm, as the README says it builds.',
      version: 1,
      definition: {
        kind: 'build',
        runsOn: { type: 'hosted', image: 'node:20' },
        inputs: [],
        variables: [],
        consumes: [],
        produces: [{ name: 'dist', paths: ['dist'] }],
        caches: [],
        commands: 'pnpm install --frozen-lockfile\npnpm build',
      },
    };
    const question = scripted('Build it the way the repository does.', [
      {
        tools: [
          { name: 'list_files', input: { path: '' } },
          { name: 'read_file', input: { path: 'README.md' } },
        ],
      },
      {
        tools: [
          {
            name: 'propose_pipeline',
            input: {
              summary: 'Adds a pnpm build after the tests.',
              checks: [check, { block: ownKey, version: 1, inputs: {} }],
              environments: [],
              blocks: [ownBlock],
            },
          },
        ],
      },
      { text: 'The README builds with pnpm, so I wrote a build block for it.' },
    ]);
    await panel.getByLabel('Ask the assistant').fill(question);
    const asked = page.waitForResponse(
      (r) => r.url().endsWith('/pipeline-builder/assistant') && r.request().method() === 'POST'
    );
    await panel.getByRole('button', { name: 'Ask' }).click();
    const answer = await asked;
    expect(answer.status()).toBe(200);
    // The pipeline on screen went with the question.
    expect(answer.request().postDataJSON().spec).toEqual({ checks: [check], environments: [] });

    await expect(panel).toContainText(
      'The README builds with pnpm, so I wrote a build block for it.'
    );
    await panel.getByText('Read 2 paths').click();
    await expect(panel).toContainText('README.md');
    const proposal = panel.getByRole('group', { name: 'Proposed pipeline' });
    await expect(proposal).toContainText(`Pull requests: Test ${tag} → Build billing ${tag}`);
    await expect(proposal).toContainText(`Build billing ${tag} (new)`);

    // --- Applied: in its row, marked as the project's own, and in the file. ---
    await proposal.getByRole('button', { name: 'Apply to the builder' }).click();
    await expect(proposal.getByRole('button', { name: 'Applied to the builder' })).toBeDisabled();
    const pullRequests = main.getByRole('region', { name: 'On every pull request' });
    await expect(pullRequests).toContainText(`Build billing ${tag}`);
    await expect(pullRequests).toContainText('this project’s own');
    const own = main.getByRole('region', { name: 'This project’s own blocks' });
    await expect(own).toContainText('Used in Pull requests');
    await shot(page, testInfo, 'pipeline-assistant-00-applied');
    await main.getByRole('tab', { name: 'The file it writes' }).click();
    const file = main.getByRole('region', { name: 'The file it writes' });
    await expect(file).toContainText('pnpm install --frozen-lockfile');
    await expect(file).toContainText(`# block: ${ownKey}@v1, this project’s own`);
    await main.getByRole('tab', { name: 'Builder' }).click();

    // The window floats over the page: collapse it to reach Save.
    await panel.getByRole('button', { name: 'Collapse the Pipeline assistant' }).click();
    await expect(panel).toBeHidden();
    // Save keeps it with the project; a reload shows it saved.
    const saved = page.waitForResponse(
      (r) => r.url().endsWith('/pipeline-builder') && r.request().method() === 'PUT'
    );
    await main.getByRole('button', { name: 'Save without opening one' }).click();
    expect((await saved).request().postDataJSON().spec.blocks[0].key).toBe(ownKey);
    await expect(main.getByRole('status').filter({ hasText: 'Pipeline saved.' })).toBeVisible();
    await page.reload();
    await expect(main.getByRole('region', { name: 'This project’s own blocks' })).toContainText(
      `Build billing ${tag}`,
      { timeout: 30_000 }
    );

    // --- Reusable: an operator has it made a building block, saved as a draft. ---
    // A reload leaves the dock collapsed and the conversation new.
    await page.getByRole('button', { name: 'Open the Pipeline assistant' }).click();
    const reuse = scripted(`Make Build billing ${tag} reusable for other projects.`, [
      {
        tools: [
          {
            name: 'propose_building_block',
            input: {
              from: ownKey,
              key: reusableKey,
              name: `Node: build with pnpm ${tag}`,
              description: 'Installs with pnpm and runs a script.',
              definition: {
                ...ownBlock.definition,
                inputs: [{ name: 'script', type: 'text', default: 'build' }],
                commands: 'pnpm install --frozen-lockfile\npnpm ${input.script}',
              },
            },
          },
        ],
      },
      { text: 'Here is a general version; the build script is an input.' },
    ]);
    await panel.getByLabel('Ask the assistant').fill(reuse);
    await panel.getByRole('button', { name: 'Ask' }).click();
    const draft = panel.getByRole('group', { name: 'Proposed building block' });
    await expect(draft).toContainText(`Node: build with pnpm ${tag}`);
    await expect(draft).toContainText(`${reusableKey} · build · inputs: script`);
    const posted = page.waitForResponse(
      (r) => r.url().endsWith('/api/admin/ci-blocks') && r.request().method() === 'POST'
    );
    await draft.getByRole('button', { name: 'Save as a building block draft' }).click();
    const create = await posted;
    expect(create.status()).toBe(201);
    const draftId: unknown = (await create.json()).id;
    if (typeof draftId === 'string') blockIds.push(draftId);
    const review = draft.getByRole('link', { name: 'Review and publish it' });
    await expect(review).toHaveAttribute('href', `/admin/ci-blocks/${String(draftId)}`);

    await shot(page, testInfo, 'pipeline-assistant-01-building-block');

    // At a phone's width: the panel is there, and nothing scrolls sideways.
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(panel).toBeInViewport({ ratio: 1 });
    const overflow = await page.evaluate(() => {
      const frame = document.querySelector('main .overflow-y-auto');
      return Math.max(
        document.documentElement.scrollWidth - document.documentElement.clientWidth,
        frame ? frame.scrollWidth - frame.clientWidth : 0
      );
    });
    expect(overflow).toBeLessThanOrEqual(0);
  } finally {
    for (const id of blockIds) await page.request.delete(`/api/admin/ci-blocks/${id}`);
    if (modelId) await page.request.delete(`/api/admin/llm-models/${modelId}`);
  }
});

test('pipeline assistant: a project that follows the default branch gets a pipeline that reads, and an answer', async ({
  page,
  request,
  person: _person,
}, testInfo) => {
  test.setTimeout(120_000);
  const tag = `${testInfo.project.name}-${randomUUID().slice(0, 6)}`;
  let modelId: string | null = null;
  await prepareCodeHost(request);
  await connectBitbucket(page);
  try {
    // No branch named: the project follows the repository's (main).
    const projectId = await createCodeProject(page.request, {
      name: `Default branch (${tag})`,
      repository: `acme/pipeline-demo-follow-${tag}`,
    });
    modelId = await addStubModel(page.request, tag);
    const onModel = await page.request.patch(`/api/chat/projects/${projectId}`, {
      data: { llmModelId: modelId },
    });
    expect(onModel.ok(), await onModel.text()).toBe(true);

    await page.goto(`/deployments/${projectId}/pipeline`);
    const main = page.getByRole('main');
    // The suggested production deploys from the repository's default branch.
    await expect(main.getByRole('textbox', { name: 'Branch that deploys production' })).toHaveValue(
      'main',
      { timeout: 30_000 }
    );

    await page.getByRole('button', { name: 'Open the Pipeline assistant' }).click();
    const panel = page.getByRole('dialog', { name: 'Pipeline assistant' });
    await panel
      .getByLabel('Ask the assistant')
      .fill(scripted('Test, lint and build it.', [{ text: 'It already deploys from main.' }]));
    const asked = page.waitForResponse(
      (r) => r.url().endsWith('/pipeline-builder/assistant') && r.request().method() === 'POST'
    );
    await panel.getByRole('button', { name: 'Ask' }).click();
    expect((await asked).status()).toBe(200);
    await expect(panel).toContainText('It already deploys from main.');
    await expect(panel.getByRole('alert')).toHaveCount(0);
  } finally {
    if (modelId) await page.request.delete(`/api/admin/llm-models/${modelId}`);
  }
});
