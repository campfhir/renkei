/**
 * Salesforce's place in a code project's pipeline: the check once among
 * the checks, one deploy step per environment, the inputs each step is
 * given, and a refusal for what a step cannot carry.
 */

import type { PipelineSpec } from '@renkei/ci-blocks';
import { planSalesforcePipeline, sourceDirectoryOf } from './salesforce-pipeline';

const BLOCKS = { validate: 1, deploy: 2 };
const OPTIONS = { sourceDirectory: 'force-app' };
const existing: PipelineSpec = {
  checks: [{ block: 'node-test', version: 1, inputs: {} }],
  environments: [
    {
      name: 'uat',
      branch: 'develop',
      steps: [{ block: 'salesforce-deploy', version: 1, inputs: { source_directory: 'src' } }],
    },
  ],
};

describe('putting Salesforce in a pipeline', () => {
  it('adds the check after the project’s own and replaces an environment’s deploy step', () => {
    const plan = planSalesforcePipeline(existing, [{ name: 'uat' }], BLOCKS, OPTIONS);
    if (typeof plan === 'string') throw new Error(plan);
    expect(plan.spec.checks).toEqual([
      { block: 'node-test', version: 1, inputs: {} },
      { block: 'salesforce-validate', version: 1, inputs: { source_directory: 'force-app' } },
    ]);
    expect(plan.spec.environments[0].steps).toEqual([
      { block: 'salesforce-deploy', version: 2, inputs: { source_directory: 'force-app' } },
    ]);
    expect(plan.changes).toEqual([
      'Checks: every pull request gets a check-only deploy against the org the repository’s variables name.',
      'uat: the deploy step is updated, with the tests Salesforce requires.',
    ]);
    // The saved spec is not changed in place.
    expect(existing.environments[0].steps[0].inputs.source_directory).toBe('src');
  });

  it('adds an environment the pipeline lacks only with its branch, after its other steps', () => {
    expect(planSalesforcePipeline(existing, [{ name: 'production' }], BLOCKS, OPTIONS)).toMatch(
      /give the branch/
    );
    const plan = planSalesforcePipeline(
      existing,
      [{ name: 'production', branch: 'main', testLevel: 'RunLocalTests' }],
      BLOCKS,
      OPTIONS
    );
    if (typeof plan === 'string') throw new Error(plan);
    expect(plan.spec.environments[1]).toEqual({
      name: 'production',
      branch: 'main',
      steps: [
        {
          block: 'salesforce-deploy',
          version: 2,
          inputs: { source_directory: 'force-app', test_level: 'RunLocalTests' },
        },
      ],
    });
    expect(plan.changes).toContain('New environment “production”, deployed by merges to main.');
    expect(plan.changes).toContain(
      'production: deploy force-app/ to the org production’s variables name, running RunLocalTests.'
    );
  });

  it('gives a step its username only when the credential is a key, and keeps the check once', () => {
    const first = planSalesforcePipeline(
      null,
      [{ name: 'uat', branch: 'develop', username: 'ci@acme.com.uat', testLevel: 'default' }],
      BLOCKS,
      { sourceDirectory: 'force-app', checkUsername: 'ci@acme.com.dev' }
    );
    if (typeof first === 'string') throw new Error(first);
    expect(first.spec.checks[0].inputs).toEqual({
      source_directory: 'force-app',
      username: 'ci@acme.com.dev',
    });
    expect(first.spec.environments[0].steps[0].inputs).toEqual({
      source_directory: 'force-app',
      username: 'ci@acme.com.uat',
    });
    const again = planSalesforcePipeline(first.spec, [{ name: 'uat' }], BLOCKS, OPTIONS);
    if (typeof again === 'string') throw new Error(again);
    expect(again.spec.checks).toHaveLength(1);
    expect(again.spec.checks[0].inputs).toEqual({ source_directory: 'force-app' });
  });

  it('refuses what a step cannot carry', () => {
    expect(planSalesforcePipeline(null, [], BLOCKS, OPTIONS)).toMatch(/at least one/);
    expect(
      planSalesforcePipeline(
        null,
        [{ name: 'uat', branch: 'develop', username: "ci'; rm -rf /" }],
        BLOCKS,
        OPTIONS
      )
    ).toMatch(/may not hold a quote/);
    expect(
      planSalesforcePipeline(
        null,
        [{ name: 'uat', branch: 'develop', testLevel: 'Everything' }],
        BLOCKS,
        OPTIONS
      )
    ).toMatch(/test level must be one of/);
  });
});

describe('sourceDirectoryOf', () => {
  it('is a path inside the repository, force-app when none is given', () => {
    expect(sourceDirectoryOf('')).toBe('force-app');
    expect(sourceDirectoryOf('/src/salesforce/')).toBe('src/salesforce');
    expect(sourceDirectoryOf('../elsewhere')).toBeNull();
    expect(sourceDirectoryOf("force-app'; echo")).toBeNull();
  });
});
