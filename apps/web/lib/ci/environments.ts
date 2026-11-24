/**
 * A code project's environments, on the server: the list as the project
 * keeps it (environment-rules.ts holds the rules), saving it against the
 * branches the repository's host lists, and the Environments page's data —
 * each environment with its branches, what the builder keeps for each
 * branch, and what the pipelines' deploy steps last reported there
 * (deployment-reports.ts). Renkei deploys nothing itself.
 */

import { getDataStore, type CiDeploymentRecord, type CiHealthRecord } from '@renkei/db';
import type { Host } from '@renkei/ci-blocks';
import { bitbucketHostAdapter } from '@/lib/code/repo-host-bitbucket';
import { githubHostAdapter } from '@/lib/code/repo-host-github';
import { settleHealth } from './deployment-changes';
import { healthView } from './health';
import type { HealthView } from './health-rules';
import {
  assignedBranches,
  environmentProblems,
  normalizeEnvironments,
  type ProjectEnvironment,
} from './environment-rules';

export interface Caller {
  subject: string;
  origin: string;
}

interface RepoProject {
  id: string;
  name: string;
  repo: { fullName: string; branch: string };
}

export interface DeploymentView {
  environment: string;
  status: string;
  commit: string;
  branch: string | null;
  target: string | null;
  runId: string;
  runUrl: string | null;
  detail: string | null;
  actor: string | null;
  startedAt: string;
  finishedAt: string | null;
}

export interface BranchView {
  name: string;
  /** False when the host no longer lists it; null when the host could not say. */
  onRemote: boolean | null;
  /** What the builder keeps for the branch; null when no pipeline was built for it here. */
  pipeline: { pullRequestUrl: string | null; written: boolean } | null;
}

export interface EnvironmentView {
  name: string;
  production: boolean;
  branches: BranchView[];
  /** The newest deployment its pipelines reported, whatever came of it. */
  latest: DeploymentView | null;
  /** The newest that succeeded: what runs there now. */
  running: DeploymentView | null;
  /** Its health check-ins, when a token was issued for it; null when it has none. */
  health: HealthView | null;
}

/** What GET /api/code/projects/[id]/environments answers. */
export interface EnvironmentsPage {
  host: Host;
  project: { name: string; repo: string };
  canEdit: boolean;
  environments: EnvironmentView[];
  /** The repository's branches as its host lists them; null when it could not. */
  remoteBranches: string[] | null;
  /** Why the branches could not be listed. */
  branchesError: string | null;
  /** The newest deployments across the environments, newest first. */
  history: DeploymentView[];
}

const HISTORY = 50;

function view(record: CiDeploymentRecord): DeploymentView {
  return {
    environment: record.environment,
    status: record.status,
    commit: record.commitSha,
    branch: record.branch,
    target: record.target,
    runId: record.runId,
    runUrl: record.runUrl,
    detail: record.detail,
    actor: record.actor,
    startedAt: record.startedAt.toISOString(),
    finishedAt: record.finishedAt?.toISOString() ?? null,
  };
}

/** The environment's check-ins, matched by name whatever its case. */
function healthOf(records: CiHealthRecord[], environment: string): HealthView | null {
  const found = records.find((r) => r.environment.toLowerCase() === environment.toLowerCase());
  return found ? healthView(found) : null;
}

/** The project's environments, as the rules hold them; a project that saved none has its production one. */
export async function projectEnvironments(projectId: string): Promise<ProjectEnvironment[]> {
  const records = await getDataStore().ciEnvironments.list(projectId);
  return normalizeEnvironments(
    records.map((r) => ({ name: r.name, production: r.production, branches: r.branches }))
  );
}

export async function remoteBranches(
  host: Host,
  caller: Caller,
  fullName: string
): Promise<{ ok: true; branches: string[] } | { ok: false; error: string }> {
  const adapter = host === 'github' ? githubHostAdapter(caller) : bitbucketHostAdapter(caller);
  const listed = await adapter.listBranches(fullName);
  return listed.ok ? { ok: true, branches: listed.branches.map((b) => b.name) } : listed;
}

export async function environmentsPage(
  host: Host,
  caller: Caller,
  project: RepoProject,
  canEdit: boolean
): Promise<EnvironmentsPage> {
  const store = getDataStore();
  const [environments, pipelines, deployments, remote, health] = await Promise.all([
    projectEnvironments(project.id),
    store.ciPipelines.listForProject(project.id),
    store.ciDeployments.recent([project.id], HISTORY),
    remoteBranches(host, caller, project.repo.fullName),
    store.ciHealth.listForProject(project.id),
  ]);
  const listed = remote.ok ? new Set(remote.branches) : null;
  // An application that went quiet is noticed by the worker's sweep; a
  // person looking at the page is as good a moment to notice it.
  const now = new Date();
  await Promise.all(health.map((record) => settleHealth(record, now)));
  return {
    host,
    project: { name: project.name, repo: project.repo.fullName },
    canEdit,
    environments: environments.map((environment) => {
      const here = deployments.filter(
        (d) => d.environment.toLowerCase() === environment.name.toLowerCase()
      );
      const latest = here[0] ?? null;
      const running = here.find((d) => d.status === 'succeeded') ?? null;
      return {
        name: environment.name,
        production: environment.production,
        branches: environment.branches.map((branch) => {
          const pipeline = pipelines.find((p) => p.branch === branch && p.host === host);
          return {
            name: branch,
            onRemote: listed ? listed.has(branch) : null,
            pipeline: pipeline
              ? {
                  pullRequestUrl: pipeline.pullRequestUrl,
                  written: pipeline.writtenText !== null,
                }
              : null,
          };
        }),
        latest: latest ? view(latest) : null,
        running: running ? view(running) : null,
        health: healthOf(health, environment.name),
      };
    }),
    remoteBranches: remote.ok ? remote.branches : null,
    branchesError: remote.ok ? null : remote.error,
    history: deployments.map(view),
  };
}

export type SaveOutcome =
  | { ok: true; environments: ProjectEnvironment[]; before: ProjectEnvironment[] }
  | { ok: false; problems: string[] };

/**
 * Save the project's list, when the rules hold for it: a branch newly
 * assigned must be one the host lists (one assigned before is kept even
 * when it has since gone, so a deleted branch can still be taken off).
 */
export async function saveEnvironments(
  host: Host,
  caller: Caller,
  project: RepoProject,
  list: ProjectEnvironment[]
): Promise<SaveOutcome> {
  const before = await projectEnvironments(project.id);
  const assignedBefore = assignedBranches(before);
  const fresh = assignedBranches(list).some((branch) => !assignedBefore.includes(branch));
  // The host is asked only when a branch is being assigned.
  const remote = fresh ? await remoteBranches(host, caller, project.repo.fullName) : null;
  if (remote && !remote.ok) {
    return {
      ok: false,
      problems: [
        `The repository’s branches could not be listed, so none can be assigned: ${remote.error}`,
      ],
    };
  }
  const problems = environmentProblems(list, {
    remoteBranches: remote?.ok ? remote.branches : null,
    assignedBefore,
  });
  if (problems.length > 0) return { ok: false, problems };
  await getDataStore().ciEnvironments.replace(project.id, list, caller.subject);
  return { ok: true, environments: list, before };
}

/** One line a change, for the audit log: what was added, removed, renamed away, assigned and taken off. */
export function environmentChanges(
  before: readonly ProjectEnvironment[],
  after: readonly ProjectEnvironment[]
): string[] {
  const names = (list: readonly ProjectEnvironment[]) => list.map((e) => e.name.toLowerCase());
  const changes: string[] = [];
  for (const e of after) {
    if (!names(before).includes(e.name.toLowerCase())) changes.push(`added ${e.name}`);
  }
  for (const e of before) {
    if (!names(after).includes(e.name.toLowerCase())) changes.push(`removed ${e.name}`);
  }
  for (const e of after) {
    const was = before.find((b) => b.name.toLowerCase() === e.name.toLowerCase());
    for (const branch of e.branches) {
      if (!was?.branches.includes(branch)) changes.push(`${e.name} ← ${branch}`);
    }
    for (const branch of was?.branches ?? []) {
      if (!e.branches.includes(branch)) changes.push(`${e.name} no longer ← ${branch}`);
    }
  }
  return changes;
}
