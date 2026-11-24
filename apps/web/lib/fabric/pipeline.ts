/**
 * Fabric workspaces through CI: the pipeline on each environment's branch
 * gets the "Fabric: check items" block among its checks and a "Fabric:
 * deploy items to a workspace" step for that environment, whose inputs
 * name its workspace (made if it does not exist, or an existing one
 * renamed to it) and capacity. A pipeline file lives on its branch, so
 * each branch gets the pipeline builder's own pull request
 * (openPipelinePullRequest); merging it is what creates or changes the
 * workspace on the next merge to that branch.
 *
 * Planning (`planFabricPipeline` for one pipeline, `planFabricPipelines`
 * for the project's branches) is apart from the call that writes, so what
 * a preview shows is what the confirm sends.
 */

import { getDataStore } from '@renkei/db';
import {
  readPipelineSpec,
  type PipelineEnvironment,
  type PipelineSpec,
  type PipelineStep,
} from '@renkei/ci-blocks';
import {
  environmentProblems,
  withBranch,
  withEnvironment,
  type ProjectEnvironment,
} from '@/lib/ci/environment-rules';
import { projectEnvironments, saveEnvironments } from '@/lib/ci/environments';
import {
  onBranch,
  openPipelinePullRequest,
  specForBranch,
  type OpenOutcome,
} from '@/lib/ci/pipeline-builder';
import type { Caller, RepoProject } from './repo';

export const VALIDATE_BLOCK = 'fabric-validate';
export const DEPLOY_BLOCK = 'fabric-deploy';

export interface FabricEnvironment {
  /** The environment's name in the pipeline: `dev`, `production`. */
  name: string;
  /** Its branch; needed only for an environment the pipeline does not have yet. */
  branch?: string;
  workspaceName: string;
  /** An existing workspace this environment uses, renamed to `workspaceName`. */
  workspaceId?: string;
  capacityId?: string;
  description?: string;
}

export interface FabricPipelinePlan {
  spec: PipelineSpec;
  /** One line per change, for the card. */
  changes: string[];
}

/** A value an input may hold: substituted into a shell word in single quotes, so never a quote. */
export function inputProblem(label: string, value: string): string | null {
  if (/['\n\r]/.test(value)) return `${label} may not hold a quote or a line break.`;
  if (value.length > 256) return `${label} is longer than 256 characters.`;
  return null;
}

/**
 * The spec with Fabric's blocks in it: the check once among the checks, and
 * one deploy step per environment named — replacing the one there, or
 * added after its other steps. A string says why it cannot be.
 */
export function planFabricPipeline(
  current: PipelineSpec | null,
  environments: FabricEnvironment[],
  blocks: { validate: number; deploy: number },
  itemsDirectory: string
): FabricPipelinePlan | string {
  if (environments.length === 0) return 'Name at least one environment and its workspace.';
  for (const env of environments) {
    for (const [label, value] of [
      ['The workspace name', env.workspaceName],
      ['The workspace id', env.workspaceId ?? ''],
      ['The capacity id', env.capacityId ?? ''],
      ['The description', env.description ?? ''],
    ] as const) {
      const problem = inputProblem(label, value);
      if (problem) return problem;
    }
  }
  const spec: PipelineSpec = current ? structuredClone(current) : { checks: [], environments: [] };
  const changes: string[] = [];

  const check: PipelineStep = {
    block: VALIDATE_BLOCK,
    version: blocks.validate,
    inputs: { items_directory: itemsDirectory },
  };
  const at = spec.checks.findIndex((step) => step.block === VALIDATE_BLOCK);
  if (at < 0) {
    spec.checks.push(check);
    changes.push('Checks: Fabric items are checked on every pull request.');
  } else {
    spec.checks[at] = check;
  }

  for (const env of environments) {
    const deploy: PipelineStep = {
      block: DEPLOY_BLOCK,
      version: blocks.deploy,
      inputs: {
        workspace_name: env.workspaceName,
        items_directory: itemsDirectory,
        ...(env.workspaceId ? { workspace_id: env.workspaceId } : {}),
        ...(env.capacityId ? { capacity_id: env.capacityId } : {}),
        ...(env.description ? { description: env.description } : {}),
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
    const existing = environment.steps.findIndex((step) => step.block === DEPLOY_BLOCK);
    const workspace = env.workspaceId
      ? `workspace ${env.workspaceId}, named “${env.workspaceName}”`
      : `workspace “${env.workspaceName}” (made if there is none)`;
    if (existing < 0) {
      environment.steps.push(deploy);
      changes.push(`${env.name}: deploy the Fabric items to ${workspace}.`);
    } else {
      environment.steps[existing] = deploy;
      changes.push(`${env.name}: deploy now goes to ${workspace}.`);
    }
    if (env.capacityId)
      changes.push(`${env.name}: the workspace runs on capacity ${env.capacityId}.`);
  }
  return { spec, changes };
}

/** The published versions of the two Fabric blocks; a string when the organization has removed one. */
export async function fabricBlockVersions(): Promise<
  { validate: number; deploy: number } | string
> {
  const store = getDataStore().ciBlocks;
  const [validate, deploy] = await Promise.all([
    store.getByKey(VALIDATE_BLOCK),
    store.getByKey(DEPLOY_BLOCK),
  ]);
  if (!validate?.latestVersion || !deploy?.latestVersion) {
    return 'The organization’s building blocks have no published “fabric-validate” and “fabric-deploy”; an operator restores them under Organization → CI building blocks.';
  }
  return { validate: validate.latestVersion, deploy: deploy.latestVersion };
}

/** One branch's pipeline with Fabric's blocks in it, for the environment the branch deploys. */
export interface FabricBranchPlan {
  environment: string;
  branch: string;
  spec: PipelineSpec;
}

export interface FabricPipelinePlans {
  branches: FabricBranchPlan[];
  /** The project's environments as they will be: a branch newly assigned, an environment added. */
  environments: ProjectEnvironment[];
  /** One line per change, for the card. */
  changes: string[];
}

/**
 * A pipeline file lives on a branch, so Fabric is set up branch by branch:
 * each named environment's branch — the one given, else the first assigned
 * to it — gets the check among its pipeline's checks and the deploy step
 * for that environment's workspace. An environment the project does not
 * have, or a branch not assigned to it yet, is added to the project's
 * environments. A string says why it cannot be.
 */
export async function planFabricPipelines(
  repo: RepoProject,
  environments: FabricEnvironment[],
  blocks: { validate: number; deploy: number },
  itemsDirectory: string
): Promise<FabricPipelinePlans | string> {
  if (environments.length === 0) return 'Name at least one environment and its workspace.';
  let list = await projectEnvironments(repo.project.id);
  const changes: string[] = [];
  const branches: FabricBranchPlan[] = [];
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
    const plan = planFabricPipeline(
      current,
      [{ ...env, name: found.name, branch }],
      blocks,
      itemsDirectory
    );
    if (typeof plan === 'string') return plan;
    branches.push({ environment: found.name, branch, spec: plan.spec });
    changes.push(...plan.changes.map((line) => line.replace(/^Checks:/, `${branch}:`)));
  }
  const problems = environmentProblems(list);
  if (problems.length > 0) return problems.join(' ');
  return { branches, environments: list, changes };
}

export type FabricWriteOutcome =
  | { ok: true; opened: { branch: string; url: string; updated: boolean }[] }
  | {
      ok: false;
      error: string;
      problems?: string[];
      /** Pull requests opened before the one that failed. */
      opened: { branch: string; url: string; updated: boolean }[];
    };

/** Save the environments as planned, then open (or add to) each branch's pipeline pull request. */
export async function writeFabricPipelines(
  caller: Caller,
  repo: RepoProject,
  plans: FabricPipelinePlans,
  now: Date
): Promise<FabricWriteOutcome> {
  const saved = await saveEnvironments(repo.host, caller, repo.project, plans.environments);
  if (!saved.ok) return { ok: false, error: saved.problems.join(' '), opened: [] };
  const opened: { branch: string; url: string; updated: boolean }[] = [];
  for (const plan of plans.branches) {
    const outcome: OpenOutcome = await openPipelinePullRequest(
      caller,
      onBranch(repo.project, plan.branch),
      plan.spec,
      now
    );
    if (!outcome.ok) {
      return {
        ok: false,
        error: `${plan.branch}: ${outcome.error}`,
        ...(outcome.problems ? { problems: outcome.problems } : {}),
        opened,
      };
    }
    opened.push({ branch: plan.branch, url: outcome.url, updated: outcome.updated });
  }
  return { ok: true, opened };
}
