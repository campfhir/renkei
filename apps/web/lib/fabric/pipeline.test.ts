/**
 * Fabric's place in a code project's pipeline: the check once among the
 * checks, one deploy step per environment naming its workspace, and a
 * refusal for what a shell word cannot carry — the plan a card shows and
 * its confirm writes.
 */

import type { PipelineSpec } from '@renkei/ci-blocks';
import { inputProblem, planFabricPipeline } from './pipeline';

const BLOCKS = { validate: 1, deploy: 2 };
const existing: PipelineSpec = {
  checks: [{ block: 'node-test', version: 1, inputs: {} }],
  environments: [
    {
      name: 'dev',
      branch: 'develop',
      steps: [{ block: 'fabric-deploy', version: 1, inputs: { workspace_name: 'Old dev' } }],
    },
  ],
};

describe('putting Fabric in a pipeline', () => {
  it('adds the check after the project’s own and replaces an environment’s deploy step', () => {
    const plan = planFabricPipeline(
      existing,
      [{ name: 'dev', workspaceName: 'Sales (dev)' }],
      BLOCKS,
      'fabric'
    );
    if (typeof plan === 'string') throw new Error(plan);
    expect(plan.spec.checks.map((step) => step.block)).toEqual(['node-test', 'fabric-validate']);
    expect(plan.spec.environments[0].steps).toEqual([
      {
        block: 'fabric-deploy',
        version: 2,
        inputs: { workspace_name: 'Sales (dev)', items_directory: 'fabric' },
      },
    ]);
    expect(plan.changes).toEqual([
      'Checks: Fabric items are checked on every pull request.',
      'dev: deploy now goes to workspace “Sales (dev)” (made if there is none).',
    ]);
    // The saved spec is not changed in place.
    expect(existing.environments[0].steps[0].inputs.workspace_name).toBe('Old dev');
  });

  it('adds an environment the pipeline lacks only with its branch', () => {
    expect(
      planFabricPipeline(
        existing,
        [{ name: 'production', workspaceName: 'Sales' }],
        BLOCKS,
        'fabric'
      )
    ).toMatch(/give the branch/);
    const plan = planFabricPipeline(
      existing,
      [{ name: 'production', branch: 'main', workspaceName: 'Sales', workspaceId: 'ws-1' }],
      BLOCKS,
      'fabric'
    );
    if (typeof plan === 'string') throw new Error(plan);
    expect(plan.spec.environments.map((e) => [e.name, e.branch])).toEqual([
      ['dev', 'develop'],
      ['production', 'main'],
    ]);
    expect(plan.changes).toContain(
      'production: deploy the Fabric items to workspace ws-1, named “Sales”.'
    );
  });

  it('starts a pipeline when the project has none', () => {
    const plan = planFabricPipeline(
      null,
      [{ name: 'dev', branch: 'develop', workspaceName: 'Dev' }],
      BLOCKS,
      'fabric'
    );
    expect(typeof plan !== 'string' && plan.spec.checks).toHaveLength(1);
  });

  it('refuses a value a deploy step’s shell could not carry', () => {
    expect(inputProblem('The workspace name', "Bob's")).toMatch(/quote/);
    expect(
      planFabricPipeline(
        null,
        [{ name: 'dev', branch: 'd', workspaceName: "Bob's" }],
        BLOCKS,
        'fabric'
      )
    ).toMatch(/quote/);
  });
});
