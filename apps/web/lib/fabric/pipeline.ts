/**
 * Fabric workspaces through CI: the code project's pipeline gets the
 * "Fabric: check items" block among its checks and a "Fabric: deploy
 * items to a workspace" step in each environment, whose inputs name the
 * environment's workspace (made if it does not exist, or an existing one
 * renamed to it) and capacity. The pipeline builder's own pull request
 * carries the change (openPipelinePullRequest); merging it, then merging
 * to an environment's branch, is what creates or changes the workspace.
 *
 * Pure planning (`planFabricPipeline`) is apart from the call that writes,
 * so what a preview shows is exactly what the confirm sends.
 */

import { getDataStore } from '@renkei/db';
import {
  readPipelineSpec,
  type PipelineEnvironment,
  type PipelineSpec,
  type PipelineStep,
} from '@renkei/ci-blocks';
import { openPipelinePullRequest, type OpenOutcome } from '@/lib/ci/pipeline-builder';
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

/** The project's saved pipeline spec, or null before one is saved. */
export async function savedSpec(repo: RepoProject): Promise<PipelineSpec | null> {
  const saved = await getDataStore().ciPipelines.get(repo.project.id);
  const read = saved ? readPipelineSpec(saved.spec) : null;
  return read?.ok ? read.value : null;
}

/** Save the planned spec and open (or add to) the pipeline builder's pull request. */
export function writeFabricPipeline(
  caller: Caller,
  repo: RepoProject,
  plan: FabricPipelinePlan,
  now: Date
): Promise<OpenOutcome> {
  return openPipelinePullRequest(caller, repo.project, plan.spec, now);
}
