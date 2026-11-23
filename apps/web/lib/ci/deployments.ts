/**
 * The Deployments pages' data: what each code project's pipeline last
 * deployed to each of its environments (as the deploy steps report it,
 * deployment-reports.ts), the deployments across them newest first, one
 * project's history, and promoting: the commits an environment's branch
 * has that the next one's does not, the pull request between them, and
 * merging it — which is what deploys, since the pipeline on the next
 * branch runs. Renkei deploys nothing itself.
 *
 * A person sees the projects they can open; promoting is an editor's,
 * with their own grant on the host, under the repository's branch rules.
 */

import { getDataStore, type CiDeploymentRecord, type CiPipelineRecord } from '@renkei/db';
import {
  PIPELINE_FILE,
  readPipelineSpec,
  type Host,
  type ManualRun,
  type PipelineSpec,
} from '@renkei/ci-blocks';
import { ATLASSIAN_BITBUCKET, GITHUB } from '@renkei/provider-grants';
import { resolveResourceAccess } from '@/lib/chat/access';
import { getProjectRow, type ProjectRow } from '@/lib/chat/projects';
import { loadChatSidebar } from '@/lib/chat/sidebar';
import { bitbucketHostAdapter } from '@/lib/code/repo-host-bitbucket';
import { githubHostAdapter } from '@/lib/code/repo-host-github';
import type { HostPipelineState, RepoHostAdapter } from '@/lib/code/repo-host';
import { commitsAhead, openPullRequest, type AheadCommit, type Caller } from './host-pulls';
import { builderTargets } from './pipeline-builder';

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

export interface EnvironmentView {
  name: string;
  branch: string;
  /** The newest deployment, whatever came of it. */
  latest: DeploymentView | null;
  /** The newest that succeeded: what runs there now. */
  running: DeploymentView | null;
}

export interface AppView {
  projectId: string;
  name: string;
  repo: string;
  host: Host;
  /** “Go”, “Node”: from the pipeline's first block named that way. */
  stack: string | null;
  canEdit: boolean;
  environments: EnvironmentView[];
}

export interface DeploymentsOverview {
  apps: AppView[];
  /** Code projects on Bitbucket or GitHub the person can open whose pipeline is not built yet. */
  unbuilt: { projectId: string; name: string; repo: string; host: Host }[];
  recent: (DeploymentView & { projectId: string; app: string })[];
  targets: { name: string; online: number; total: number }[];
}

export interface Promotion {
  from: string;
  to: string;
  fromBranch: string;
  toBranch: string;
  /** What merging brings; null when the host could not say. */
  ahead: { commits: AheadCommit[]; count: number; more: boolean } | null;
  pullRequest: {
    number: number;
    title: string;
    url: string;
    checks: string | null;
  } | null;
  /** Why the host could not be asked. */
  error: string | null;
}

/** One of the repository's branches, as the app's Branches list shows it. */
export interface BranchView {
  name: string;
  /** The head commit, as the host lists it. */
  commit: { sha: string; message: string | null; date: string | null };
  /** The newest pipeline run on it; null when none is listed. */
  run: { state: HostPipelineState; url: string; startedAt: string } | null;
  /** The environment this branch deploys, if one does. */
  environment: string | null;
}

export interface AppDetail extends AppView {
  /** False until the project's pipeline is built (or saved) in Renkei. */
  hasPipeline: boolean;
  history: DeploymentView[];
  promotions: Promotion[];
  /** Every branch: environments' first, then by latest activity; null when the host could not list them. */
  branches: BranchView[] | null;
  branchesError: string | null;
  /** Whether the pipeline has checks to start by hand on a branch. */
  hasChecks: boolean;
}

const HISTORY = 50;
/** Branches listed in an app: the environments' and the most recently active. */
const BRANCHES = 50;
/** Runs read to find each branch's newest. */
const RUNS_READ = 100;
const ACROSS = 300;

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

function hostOfProvider(provider: string): Host | null {
  return provider === GITHUB ? 'github' : provider === ATLASSIAN_BITBUCKET ? 'bitbucket' : null;
}

function adapterFor(host: Host, caller: Caller): RepoHostAdapter {
  return host === 'github' ? githubHostAdapter(caller) : bitbucketHostAdapter(caller);
}

interface Visible {
  pipeline: CiPipelineRecord;
  spec: PipelineSpec;
  project: ProjectRow & { repo: NonNullable<ProjectRow['repo']> };
  host: Host;
  canEdit: boolean;
}

/** The pipelines whose projects the person can open, by project name. */
async function visiblePipelines(
  subject: string,
  only?: string,
  options: { withoutEnvironments?: boolean } = {}
): Promise<Visible[]> {
  const pipelines = (await getDataStore().ciPipelines.list()).filter(
    (p) => !only || p.projectId === only
  );
  const out: Visible[] = [];
  for (const pipeline of pipelines) {
    const spec = readPipelineSpec(pipeline.spec);
    if (!spec.ok || (spec.value.environments.length === 0 && !options.withoutEnvironments))
      continue;
    const access = await resolveResourceAccess(subject, 'chat_project', pipeline.projectId);
    if (!access) continue;
    const project = await getProjectRow(pipeline.projectId);
    const host = project?.repo ? hostOfProvider(project.repo.provider) : null;
    if (!project?.repo || !host) continue;
    out.push({
      pipeline,
      spec: spec.value,
      project: { ...project, repo: project.repo },
      host,
      canEdit: access.role !== 'viewer',
    });
  }
  return out.sort((a, b) => a.project.name.localeCompare(b.project.name));
}

async function stackNames(): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  for (const block of await getDataStore().ciBlocks.list()) {
    const stack = /^([^:]{1,24}):/.exec(block.name)?.[1]?.trim();
    if (stack) names.set(block.key, stack);
  }
  return names;
}

function appOf(
  item: Visible,
  deployments: CiDeploymentRecord[],
  stacks: Map<string, string>
): AppView {
  const mine = deployments.filter((d) => d.projectId === item.project.id);
  const steps = [...item.spec.checks, ...item.spec.environments.flatMap((e) => e.steps)];
  return {
    projectId: item.project.id,
    name: item.project.name,
    repo: item.project.repo.fullName,
    host: item.host,
    stack: steps.map((s) => stacks.get(s.block)).find(Boolean) ?? null,
    canEdit: item.canEdit,
    environments: item.spec.environments.map((environment) => {
      const here = mine.filter((d) => d.environment === environment.name);
      const latest = here[0] ?? null;
      const running = here.find((d) => d.status === 'succeeded') ?? null;
      return {
        name: environment.name,
        branch: environment.branch,
        latest: latest ? view(latest) : null,
        running: running ? view(running) : null,
      };
    }),
  };
}

export async function deploymentsOverview(subject: string): Promise<DeploymentsOverview> {
  const visible = await visiblePipelines(subject);
  const ids = visible.map((v) => v.project.id);
  const [deployments, stacks, targets] = await Promise.all([
    getDataStore().ciDeployments.recent(ids, ACROSS),
    stackNames(),
    builderTargets(),
  ]);
  const names = new Map(visible.map((v) => [v.project.id, v.project.name]));
  const built = new Set((await getDataStore().ciPipelines.list()).map((p) => p.projectId));
  return {
    apps: visible.map((item) => appOf(item, deployments, stacks)),
    unbuilt: await unbuiltProjects(subject, built),
    recent: deployments.slice(0, 20).map((d) => ({
      ...view(d),
      projectId: d.projectId,
      app: names.get(d.projectId) ?? '',
    })),
    targets: targets.map((t) => ({
      name: t.name,
      online: t.runners.filter((r) => r.status === 'online').length,
      total: t.runners.length,
    })),
  };
}

/** Each environment and the next, where they deploy from different branches. */
function pairs(
  spec: PipelineSpec
): { from: PipelineSpec['environments'][number]; to: PipelineSpec['environments'][number] }[] {
  const out = [];
  for (let i = 0; i + 1 < spec.environments.length; i += 1) {
    const from = spec.environments[i];
    const to = spec.environments[i + 1];
    if (from.branch !== to.branch) out.push({ from, to });
  }
  return out;
}

async function promotionOf(
  item: Visible,
  caller: Caller,
  pair: ReturnType<typeof pairs>[number]
): Promise<Promotion> {
  const { fullName } = item.project.repo;
  const adapter = adapterFor(item.host, caller);
  const [ahead, open] = await Promise.all([
    commitsAhead(item.host, caller, fullName, pair.from.branch, pair.to.branch),
    adapter.listPullRequests(fullName, { state: 'open', max: 50 }),
  ]);
  const found = open.ok
    ? open.pullRequests.find(
        (pr) => pr.sourceBranch === pair.from.branch && pr.destinationBranch === pair.to.branch
      )
    : undefined;
  const detail = found ? await adapter.getPullRequest(fullName, found.number) : null;
  const errors = [!ahead.ok ? ahead.error : null, !open.ok ? open.error : null].filter(
    (e): e is string => Boolean(e)
  );
  return {
    from: pair.from.name,
    to: pair.to.name,
    fromBranch: pair.from.branch,
    toBranch: pair.to.branch,
    ahead: ahead.ok ? { commits: ahead.commits, count: ahead.count, more: ahead.more } : null,
    pullRequest: found
      ? {
          number: found.number,
          title: found.title,
          url: found.url,
          checks: detail?.ok ? detail.pullRequest.checksState : null,
        }
      : null,
    error: errors.length > 0 ? errors.join(' ') : null,
  };
}

/**
 * The repository's branches with their newest run and the environment each
 * deploys: environments' branches first (in pipeline order), then the rest
 * by their latest run or commit, newest first, then by name.
 */
export function branchList(
  spec: PipelineSpec,
  branches: {
    name: string;
    headSha: string;
    headDate?: string | null;
    headMessage?: string | null;
  }[],
  runs: { ref: string; state: HostPipelineState; url: string; startedAt: string }[]
): BranchView[] {
  const newest = new Map<string, (typeof runs)[number]>();
  for (const run of runs) {
    const seen = newest.get(run.ref);
    if (!seen || run.startedAt > seen.startedAt) newest.set(run.ref, run);
  }
  const order = spec.environments.map((e) => e.branch);
  const views = branches.map((branch): BranchView => {
    const run = newest.get(branch.name);
    return {
      name: branch.name,
      commit: {
        sha: branch.headSha,
        message: branch.headMessage ?? null,
        date: branch.headDate ?? null,
      },
      run: run ? { state: run.state, url: run.url, startedAt: run.startedAt } : null,
      environment: spec.environments.find((e) => e.branch === branch.name)?.name ?? null,
    };
  });
  const active = (b: BranchView) => b.run?.startedAt ?? b.commit.date ?? '';
  return views
    .sort((a, b) => {
      const ai = order.indexOf(a.name);
      const bi = order.indexOf(b.name);
      if (ai !== -1 || bi !== -1) return (ai === -1 ? Infinity : ai) - (bi === -1 ? Infinity : bi);
      const byActivity = active(b).localeCompare(active(a));
      return byActivity !== 0 ? byActivity : a.name.localeCompare(b.name);
    })
    .slice(0, BRANCHES);
}

async function branchesOf(
  item: Visible,
  caller: Caller
): Promise<{ branches: BranchView[] | null; error: string | null }> {
  const adapter = adapterFor(item.host, caller);
  const { fullName } = item.project.repo;
  const [branches, runs] = await Promise.all([
    adapter.listBranches(fullName),
    adapter.listPipelineRuns(fullName, { max: RUNS_READ }),
  ]);
  if (!branches.ok) return { branches: null, error: branches.error };
  return {
    branches: branchList(item.spec, branches.branches, runs.ok ? runs.runs : []),
    error: runs.ok ? null : `Its runs could not be read: ${runs.error}`,
  };
}

export async function deploymentDetail(
  caller: Caller,
  projectId: string
): Promise<AppDetail | null> {
  const [item] = await visiblePipelines(caller.subject, projectId, { withoutEnvironments: true });
  if (!item) return unbuiltDetail(caller.subject, projectId);
  const [history, stacks] = await Promise.all([
    getDataStore().ciDeployments.recent([item.project.id], HISTORY),
    stackNames(),
  ]);
  const [promotions, branches] = await Promise.all([
    Promise.all(pairs(item.spec).map((pair) => promotionOf(item, caller, pair))),
    branchesOf(item, caller),
  ]);
  return {
    ...appOf(item, history, stacks),
    hasPipeline: true,
    history: history.map(view),
    promotions,
    branches: branches.branches,
    branchesError: branches.error,
    hasChecks: item.spec.checks.length > 0,
  };
}

/** A code project the person can open whose pipeline is not built yet: its app, empty. */
async function unbuiltDetail(subject: string, projectId: string): Promise<AppDetail | null> {
  const access = await resolveResourceAccess(subject, 'chat_project', projectId);
  const project = access ? await getProjectRow(projectId) : null;
  const host = project?.repo ? hostOfProvider(project.repo.provider) : null;
  if (!access || !project?.repo || !host) return null;
  return {
    projectId: project.id,
    name: project.name,
    repo: project.repo.fullName,
    host,
    stack: null,
    canEdit: access.role !== 'viewer',
    environments: [],
    hasPipeline: false,
    history: [],
    promotions: [],
    branches: null,
    branchesError: null,
    hasChecks: false,
  };
}

/** The code projects the person can open, on either host, with no pipeline built yet. */
async function unbuiltProjects(
  subject: string,
  built: Set<string>
): Promise<DeploymentsOverview['unbuilt']> {
  const sidebar = await loadChatSidebar(subject);
  const out: DeploymentsOverview['unbuilt'] = [];
  for (const listed of sidebar.code.projects) {
    if (built.has(listed.id)) continue;
    const project = await getProjectRow(listed.id);
    const host = project?.repo ? hostOfProvider(project.repo.provider) : null;
    if (project?.repo && host) {
      out.push({ projectId: project.id, name: project.name, repo: project.repo.fullName, host });
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export type PromoteOutcome =
  | { ok: true; number: number; url: string; project: string; repository: string }
  | { ok: false; status: number; error: string };

/** The environment pair named, if the project's pipeline has it. */
async function editablePair(
  caller: Caller,
  projectId: string,
  from: string,
  to: string
): Promise<
  | { ok: true; item: Visible; pair: ReturnType<typeof pairs>[number] }
  | { ok: false; status: number; error: string }
> {
  const [item] = await visiblePipelines(caller.subject, projectId);
  if (!item) return { ok: false, status: 404, error: 'No such project with a pipeline.' };
  if (!item.canEdit)
    return { ok: false, status: 403, error: 'Only the project’s editors promote it.' };
  const pair = pairs(item.spec).find((p) => p.from.name === from && p.to.name === to);
  if (!pair) {
    return { ok: false, status: 400, error: `The pipeline does not promote ${from} to ${to}.` };
  }
  return { ok: true, item, pair };
}

/** Open the pull request that promotes one environment to the next. */
export async function openPromotion(
  caller: Caller,
  projectId: string,
  from: string,
  to: string
): Promise<PromoteOutcome> {
  const found = await editablePair(caller, projectId, from, to);
  if (!found.ok) return found;
  const { item, pair } = found;
  const opened = await openPullRequest(item.host, caller, item.project.repo.fullName, {
    from: pair.from.branch,
    to: pair.to.branch,
    title: `Promote ${pair.from.name} to ${pair.to.name}`,
    description: [
      `Merging this brings what ${pair.from.name} runs (\`${pair.from.branch}\`) to ${pair.to.name} (\`${pair.to.branch}\`).`,
      '',
      `The pipeline on \`${pair.to.branch}\` deploys it, and reports to Renkei when it has.`,
    ].join('\n'),
  });
  if (!opened.ok) return { ok: false, status: 502, error: opened.error };
  return {
    ok: true,
    number: opened.number,
    url: opened.url,
    project: item.project.name,
    repository: item.project.repo.fullName,
  };
}

/** Merge the promotion's pull request: it must be the open one from one environment's branch to the next's. */
export async function mergePromotion(
  caller: Caller,
  projectId: string,
  from: string,
  to: string,
  number: number
): Promise<PromoteOutcome> {
  const found = await editablePair(caller, projectId, from, to);
  if (!found.ok) return found;
  const { item, pair } = found;
  const adapter = adapterFor(item.host, caller);
  const pr = await adapter.getPullRequest(item.project.repo.fullName, number);
  if (!pr.ok) return { ok: false, status: 502, error: pr.error };
  const p = pr.pullRequest;
  if (
    p.state !== 'open' ||
    p.sourceBranch !== pair.from.branch ||
    p.destinationBranch !== pair.to.branch
  ) {
    return {
      ok: false,
      status: 409,
      error: `Pull request #${number} is not the open one from ${pair.from.branch} to ${pair.to.branch}.`,
    };
  }
  const merged = await adapter.mergePullRequest(item.project.repo.fullName, number);
  if (!merged.ok) return { ok: false, status: 502, error: merged.error };
  return {
    ok: true,
    number,
    url: merged.url,
    project: item.project.name,
    repository: item.project.repo.fullName,
  };
}

export type ManualRunOutcome =
  | { ok: true; url: string; project: string; repository: string }
  | { ok: false; status: number; error: string };

/** A manual run as sent: `run` is "checks" or an environment's name. */
export function readManualRun(
  spec: PipelineSpec,
  branch: string,
  run: string
): { ok: true; run: ManualRun } | { ok: false; status: number; error: string } {
  if (!branch.trim()) return { ok: false, status: 400, error: 'Name the branch to run on.' };
  if (run === 'checks') {
    return spec.checks.length > 0
      ? { ok: true, run: { kind: 'checks' } }
      : { ok: false, status: 400, error: 'The pipeline has no checks to run.' };
  }
  const environment = spec.environments.find((e) => e.name === run);
  if (!environment) {
    return { ok: false, status: 400, error: `The pipeline has no environment named ${run}.` };
  }
  if (environment.steps.length === 0) {
    return { ok: false, status: 400, error: `${environment.name} has no steps to run.` };
  }
  if (environment.branch !== branch) {
    return {
      ok: false,
      status: 409,
      error: `${environment.name} deploys only from ${environment.branch}, not ${branch}.`,
    };
  }
  return { ok: true, run: { kind: 'deploy', environment: environment.name } };
}

/**
 * Start the pipeline by hand on a branch, with the person's own grant:
 * the checks on any branch, or an environment's deploy from its own branch.
 */
export async function startManualRun(
  caller: Caller,
  projectId: string,
  branch: string,
  run: string
): Promise<ManualRunOutcome> {
  const [item] = await visiblePipelines(caller.subject, projectId, { withoutEnvironments: true });
  if (!item) return { ok: false, status: 404, error: 'No such project with a pipeline.' };
  if (!item.canEdit) {
    return { ok: false, status: 403, error: 'Only the project’s editors start its pipeline.' };
  }
  const read = readManualRun(item.spec, branch, run);
  if (!read.ok) return read;
  const started = await adapterFor(item.host, caller).startPipelineRun(
    item.project.repo.fullName,
    branch,
    read.run
  );
  if (!started.ok) {
    return {
      ok: false,
      status: 502,
      error: `${started.error} If ${PIPELINE_FILE[item.host]} on ${branch} was written before runs could be started from Renkei, update it from the Pipeline tab.`,
    };
  }
  return {
    ok: true,
    url: started.url,
    project: item.project.name,
    repository: item.project.repo.fullName,
  };
}
