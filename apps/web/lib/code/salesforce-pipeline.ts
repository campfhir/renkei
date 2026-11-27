/**
 * Salesforce orgs through CI: the pipeline on each environment's branch
 * gets the "Salesforce: check a deploy" block among its checks and a
 * "Salesforce: deploy to an org" step for that environment (packages/db
 * migration 200). A pipeline file lives on its branch, so each branch gets
 * the pipeline builder's own pull request; merging it is what makes later
 * merges to that branch deploy.
 *
 * Which org a step signs in to is not here: the blocks read it from the
 * host's variables (SF_LOGIN_URL, SF_CLIENT_ID and the secret
 * SF_CLIENT_CREDENTIAL), an environment's own for its deploy and the
 * repository's for the checks on a pull request. A person sets the secret
 * on the project's Variables tab; no tool here sees it.
 *
 * Planning (`planSalesforcePipeline` for one pipeline,
 * `planSalesforcePipelines` for the project's branches) is apart from the
 * call that writes, and code_salesforce_setup_pipeline is both: a local
 * tool of a code project's chat, bound to that project.
 */

import { getDataStore } from '@renkei/db';
import {
  readPipelineSpec,
  type PipelineEnvironment,
  type PipelineSpec,
  type PipelineStep,
} from '@renkei/ci-blocks';
import { isRecord, isString } from '@renkei/guards';
import {
  environmentProblems,
  withBranch,
  withEnvironment,
  type ProjectEnvironment,
} from '@/lib/ci/environment-rules';
import { projectEnvironments } from '@/lib/ci/environments';
import { specForBranch } from '@/lib/ci/pipeline-builder';
import { errorResult, textResult, type LocalTool } from '@/lib/chat/local-tools';
import { inputProblem, writeFabricPipelines } from '@/lib/fabric/pipeline';
import { resolveRepoProject, type RepoProject } from '@/lib/fabric/repo';

export const VALIDATE_BLOCK = 'salesforce-validate';
export const DEPLOY_BLOCK = 'salesforce-deploy';
export const SALESFORCE_PIPELINE_TOOL = 'code_salesforce_setup_pipeline';

export const TEST_LEVELS = [
  'default',
  'NoTestRun',
  'RunSpecifiedTests',
  'RunLocalTests',
  'RunAllTestsInOrg',
  'RunRelevantTests',
] as const;

export interface SalesforceEnvironment {
  /** The environment's name in the pipeline: `uat`, `production`. */
  name: string;
  /** Its branch; needed only for an environment the pipeline does not have yet. */
  branch?: string;
  /** The integration user, when the environment's credential is a private key. */
  username?: string;
  /** Apex tests the deploy runs; absent leaves it to Salesforce. */
  testLevel?: string;
}

export interface SalesforcePipelineOptions {
  /** Where the repository keeps its Salesforce source. */
  sourceDirectory: string;
  /** The integration user pull requests are checked as, when the repository's credential is a private key. */
  checkUsername?: string;
}

export interface SalesforcePipelinePlan {
  spec: PipelineSpec;
  /** One line per change, in the tool's answer. */
  changes: string[];
}

/** A source directory inside the repository, without the slashes at its ends; null when it is not one. */
export function sourceDirectoryOf(value: string): string | null {
  const path = value.trim().replace(/^\/+|\/+$/g, '');
  if (!path) return 'force-app';
  if (!/^[A-Za-z0-9._/-]{1,200}$/.test(path) || path.split('/').includes('..')) return null;
  return path;
}

function inputsProblem(
  environments: readonly SalesforceEnvironment[],
  options: SalesforcePipelineOptions
): string | null {
  const username = inputProblem('The check’s username', options.checkUsername ?? '');
  if (username) return username;
  for (const env of environments) {
    const problem = inputProblem(`${env.name}’s username`, env.username ?? '');
    if (problem) return problem;
    if (env.testLevel && !TEST_LEVELS.some((level) => level === env.testLevel)) {
      return `${env.name}’s test level must be one of ${TEST_LEVELS.join(', ')}.`;
    }
  }
  return null;
}

/**
 * The spec with Salesforce's blocks in it: the check once among the checks,
 * and one deploy step per environment named — replacing the one there, or
 * added after its other steps. A string says why it cannot be.
 */
export function planSalesforcePipeline(
  current: PipelineSpec | null,
  environments: SalesforceEnvironment[],
  blocks: { validate: number; deploy: number },
  options: SalesforcePipelineOptions
): SalesforcePipelinePlan | string {
  if (environments.length === 0) return 'Name at least one environment.';
  const problem = inputsProblem(environments, options);
  if (problem) return problem;
  const spec: PipelineSpec = current ? structuredClone(current) : { checks: [], environments: [] };
  const changes: string[] = [];

  const check: PipelineStep = {
    block: VALIDATE_BLOCK,
    version: blocks.validate,
    inputs: {
      source_directory: options.sourceDirectory,
      ...(options.checkUsername ? { username: options.checkUsername } : {}),
    },
  };
  const at = spec.checks.findIndex((step) => step.block === VALIDATE_BLOCK);
  if (at < 0) {
    spec.checks.push(check);
    changes.push(
      'Checks: every pull request gets a check-only deploy against the org the repository’s variables name.'
    );
  } else {
    spec.checks[at] = check;
  }

  for (const env of environments) {
    const deploy: PipelineStep = {
      block: DEPLOY_BLOCK,
      version: blocks.deploy,
      inputs: {
        source_directory: options.sourceDirectory,
        ...(env.username ? { username: env.username } : {}),
        ...(env.testLevel && env.testLevel !== 'default' ? { test_level: env.testLevel } : {}),
      },
    };
    let environment: PipelineEnvironment | undefined = spec.environments.find(
      (e) => e.name === env.name
    );
    if (!environment) {
      if (!env.branch?.trim()) {
        return `The pipeline has no environment “${env.name}”; give the branch whose merges deploy it.`;
      }
      environment = { name: env.name, branch: env.branch.trim(), steps: [] };
      spec.environments.push(environment);
      changes.push(`New environment “${env.name}”, deployed by merges to ${environment.branch}.`);
    }
    const tests =
      env.testLevel && env.testLevel !== 'default'
        ? `running ${env.testLevel}`
        : 'with the tests Salesforce requires';
    const existing = environment.steps.findIndex((step) => step.block === DEPLOY_BLOCK);
    if (existing < 0) {
      environment.steps.push(deploy);
      changes.push(
        `${env.name}: deploy ${options.sourceDirectory}/ to the org ${env.name}’s variables name, ${tests}.`
      );
    } else {
      environment.steps[existing] = deploy;
      changes.push(`${env.name}: the deploy step is updated, ${tests}.`);
    }
  }
  return { spec, changes };
}

/** The published versions of the two Salesforce blocks; a string when the organization has removed one. */
export async function salesforceBlockVersions(): Promise<
  { validate: number; deploy: number } | string
> {
  const store = getDataStore().ciBlocks;
  const [validate, deploy] = await Promise.all([
    store.getByKey(VALIDATE_BLOCK),
    store.getByKey(DEPLOY_BLOCK),
  ]);
  if (!validate?.latestVersion || !deploy?.latestVersion) {
    return 'The organization’s building blocks have no published “salesforce-validate” and “salesforce-deploy”; an operator restores them under Organization → CI building blocks.';
  }
  return { validate: validate.latestVersion, deploy: deploy.latestVersion };
}

export interface SalesforcePipelinePlans {
  branches: { environment: string; branch: string; spec: PipelineSpec }[];
  /** The project's environments as they will be: a branch newly assigned, an environment added. */
  environments: ProjectEnvironment[];
  changes: string[];
}

/**
 * A pipeline file lives on a branch, so Salesforce is set up branch by
 * branch: each named environment's branch — the one given, else the first
 * assigned to it — gets the check among its pipeline's checks and the
 * deploy step for that environment. An environment the project does not
 * have, or a branch not assigned to it yet, is added to the project's
 * environments. A string says why it cannot be.
 */
export async function planSalesforcePipelines(
  repo: RepoProject,
  environments: SalesforceEnvironment[],
  blocks: { validate: number; deploy: number },
  options: SalesforcePipelineOptions
): Promise<SalesforcePipelinePlans | string> {
  if (environments.length === 0) return 'Name at least one environment.';
  let list = await projectEnvironments(repo.project.id);
  const changes: string[] = [];
  const branches: SalesforcePipelinePlans['branches'] = [];
  for (const env of environments) {
    let found = list.find((e) => e.name.toLowerCase() === env.name.toLowerCase());
    const branch = env.branch?.trim() || found?.branches[0];
    if (!branch) {
      return found
        ? `The project’s environment “${found.name}” has no branch assigned; give the branch whose merges deploy it.`
        : `The project has no environment “${env.name}”; give the branch whose merges deploy it.`;
    }
    if (!found) {
      list = withEnvironment(list, env.name);
      found = list[list.length - 1]!;
      changes.push(`New environment “${found.name}”.`);
    }
    if (!found.branches.includes(branch)) {
      list = withBranch(list, found.name, branch);
      changes.push(`${branch} is assigned to ${found.name}: merges to it deploy ${found.name}.`);
    }
    const saved = await getDataStore().ciPipelines.get(repo.project.id, branch);
    const read = saved ? readPipelineSpec(saved.spec) : null;
    const current = specForBranch(
      read?.ok ? read.value : { checks: [], environments: [] },
      found.name,
      branch
    );
    const plan = planSalesforcePipeline(
      current,
      [{ ...env, name: found.name, branch }],
      blocks,
      options
    );
    if (typeof plan === 'string') return plan;
    branches.push({ environment: found.name, branch, spec: plan.spec });
    changes.push(...plan.changes.map((line) => line.replace(/^Checks:/, `${branch}:`)));
  }
  const problems = environmentProblems(list);
  if (problems.length > 0) return problems.join(' ');
  return { branches, environments: list, changes };
}

const text = (value: unknown): string => (isString(value) ? value.trim() : '');

/** The environments a call named, read from its input; a string says what is wrong with them. */
function environmentsOf(value: unknown): SalesforceEnvironment[] | string {
  if (!Array.isArray(value) || value.length === 0) return 'Name at least one environment.';
  if (value.length > 6) return 'At most six environments in one call.';
  const environments: SalesforceEnvironment[] = [];
  for (const entry of value) {
    const name = isRecord(entry) ? text(entry.name) : '';
    if (!isRecord(entry) || !name) return 'Every environment needs a name.';
    environments.push({
      name,
      ...(text(entry.branch) ? { branch: text(entry.branch) } : {}),
      ...(text(entry.username) ? { username: text(entry.username) } : {}),
      ...(text(entry.testLevel) ? { testLevel: text(entry.testLevel) } : {}),
    });
  }
  return environments;
}

const VARIABLES_NOTE =
  'Before the first run, each environment needs the variables SF_LOGIN_URL (the org’s My Domain address) and SF_CLIENT_ID (the app’s consumer key) and the secret SF_CLIENT_CREDENTIAL (the app’s consumer secret, or its private key), and the repository needs the same three for the org pull requests are checked against. You can set the two plain ones with code_pipeline_set_variables when the person gives them; the secret is the person’s to enter on the project’s Environments page, under Variables — never ask for it in the chat.';

export function salesforcePipelineTools(deps: { origin: string }): LocalTool[] {
  return [
    {
      def: {
        name: SALESFORCE_PIPELINE_TOOL,
        description:
          'Set up this project’s pipeline to deploy its Salesforce DX source: a check-only deploy on every pull request, and a deploy to each named environment’s org when a change merges to that environment’s branch. It saves the project’s environments and opens the pipeline’s own pull request into each branch; nothing deploys until those are merged. The org each step signs in to comes from the pipeline’s variables, not from here.',
        inputSchema: {
          type: 'object',
          properties: {
            environments: {
              type: 'array',
              minItems: 1,
              maxItems: 6,
              description: 'The environments to deploy, each an org.',
              items: {
                type: 'object',
                properties: {
                  name: {
                    type: 'string',
                    description: 'The environment’s name: uat, production.',
                  },
                  branch: {
                    type: 'string',
                    description:
                      'The branch whose merges deploy it. Needed for an environment the project does not have yet.',
                  },
                  username: {
                    type: 'string',
                    description:
                      'The integration user’s username, only when the environment’s credential is a private key (JWT) and not a consumer secret.',
                  },
                  testLevel: {
                    type: 'string',
                    enum: [...TEST_LEVELS],
                    description:
                      'Apex tests the deploy runs. default leaves it to Salesforce: none in a sandbox, local tests in production.',
                  },
                },
                required: ['name'],
                additionalProperties: false,
              },
            },
            sourceDirectory: {
              type: 'string',
              description: 'Where the repository keeps its Salesforce source. Default force-app.',
            },
            checkUsername: {
              type: 'string',
              description:
                'The integration user pull requests are checked as, only when the repository’s credential is a private key.',
            },
          },
          required: ['environments'],
          additionalProperties: false,
        },
      },
      async execute(input, context) {
        if (!context.projectId) return errorResult('This chat is not in a code project.');
        const environments = environmentsOf(input.environments);
        if (typeof environments === 'string') return errorResult(environments);
        const sourceDirectory = sourceDirectoryOf(text(input.sourceDirectory));
        if (sourceDirectory === null) {
          return errorResult('The source directory must be a path inside the repository.');
        }
        const repo = await resolveRepoProject(context.subject, context.projectId);
        if (typeof repo === 'string') return errorResult(repo);
        const blocks = await salesforceBlockVersions();
        if (typeof blocks === 'string') return errorResult(blocks);
        const checkUsername = text(input.checkUsername);
        const plan = await planSalesforcePipelines(repo, environments, blocks, {
          sourceDirectory,
          ...(checkUsername ? { checkUsername } : {}),
        });
        if (typeof plan === 'string') return errorResult(plan);
        const written = await writeFabricPipelines(
          { subject: context.subject, origin: context.origin ?? deps.origin },
          repo,
          plan,
          new Date()
        );
        const pullRequests = written.opened
          .map(
            (pr) =>
              `${pr.updated ? 'Added to' : 'Opened'} the pipeline’s pull request into ${pr.branch}: ${pr.url}`
          )
          .join('\n');
        if (!written.ok) {
          return errorResult(
            `${pullRequests ? `${pullRequests}\n` : ''}Could not open a pipeline pull request: ${written.error}` +
              (written.problems?.length ? `\n${written.problems.join('\n')}` : '')
          );
        }
        return textResult(`${pullRequests}\n${plan.changes.join('\n')}\n\n${VARIABLES_NOTE}`);
      },
    },
  ];
}
