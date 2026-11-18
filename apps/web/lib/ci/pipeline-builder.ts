/**
 * A code project's pipeline builder (the page at /code/[projectId]/pipeline-builder):
 * the organization's published blocks, its targets with the runners each
 * host reports, what the repository's host says (its variables, deployment
 * environments, branches, top-level files and the pipeline file already on
 * the project's branch), the pipeline saved for the project or one
 * suggested from those files, and opening the pull request that carries
 * the file. @renkei/ci-blocks renders the file and checks it; the page
 * runs the same checks as the person edits.
 *
 * Renkei never deploys and never commits to the project's branch here: the
 * file goes on a `renkei/pipeline` branch and into a pull request against
 * the project's branch, with the person's own grant on the host, so the
 * repository's branch rules and reviews apply. While that pull request is
 * open, opening it again adds a commit to it rather than starting another.
 */

import { getDataStore } from '@renkei/db';
import {
  HOST_LABEL,
  PIPELINE_FILE,
  REPORT_PATH,
  partName,
  readBlockDefinition,
  readPipelineSpec,
  renderPipeline,
  suggestPipeline,
  type CheckTarget,
  type Host,
  type HostFacts,
  type PipelineBlock,
  type PipelineSpec,
  type ReportTo,
} from '@renkei/ci-blocks';
import { ATLASSIAN_BITBUCKET, GITHUB } from '@renkei/provider-grants';
import type { ProjectRow } from '@/lib/chat/projects';
import { bitbucketAuthOf, listSource as listBitbucketSource } from '@/lib/code/bitbucket-browse';
import {
  listVariables,
  readEnvironments as readBitbucketEnvironments,
  readPipelineConfigFile,
  repoBase,
  variablesPath,
} from '@/lib/code/bitbucket-pipelines';
import { githubAuthOf, listSource as listGithubSource } from '@/lib/code/github-browse';
import {
  commitWorkflowFile,
  ownerRepoOf,
  readActionsSetup,
  readWorkflowFile,
} from '@/lib/code/github-actions';
import type { HostBranch } from '@/lib/code/repo-host';
import { bitbucketHostAdapter } from '@/lib/code/repo-host-bitbucket';
import { githubHostAdapter } from '@/lib/code/repo-host-github';
import { bbJson, describeBitbucketFailure } from '@/lib/mcp-tools/bitbucket/client';
import { ghJson, rec, str } from '@/lib/mcp-tools/github/client';
import { bareUuid } from './oidc';
import { listTargets, targetsPage } from './targets';

export type CodeRepoProject = ProjectRow & { repo: NonNullable<ProjectRow['repo']> };

/** The branch the builder's pull requests come from. */
export const PIPELINE_BRANCH = 'renkei/pipeline';
const WORKFLOW_NAME = 'pipeline.yml';

export interface BuilderBlock extends PipelineBlock {
  description: string | null;
}

export interface BuilderPage {
  host: Host;
  file: string;
  spec: PipelineSpec;
  /** True when nothing is saved yet and the spec was suggested from the repository. */
  suggested: boolean;
  /** What was found in the repository, for the page's header. */
  found: string[];
  /** Every published block at its latest version, and any older version the spec still uses. */
  blocks: BuilderBlock[];
  targets: CheckTarget[];
  facts: HostFacts;
  /** What could not be read from the host, in its words. */
  unread: string[];
  pullRequestUrl: string | null;
  /** Where each deploy step reports; null when Renkei's own address is unknown. */
  report: ReportTo | null;
}

/** Where a pipeline's deploy steps report: this Renkei's report endpoint, and its address as the audience. */
export function reportTo(origin: string): ReportTo | null {
  const base = origin.replace(/\/+$/, '');
  return /^https?:\/\/[^/\s]+$/.test(base)
    ? { url: `${base}${REPORT_PATH}`, audience: base }
    : null;
}

export function hostOf(provider: string): Host | null {
  return provider === GITHUB ? 'github' : provider === ATLASSIAN_BITBUCKET ? 'bitbucket' : null;
}

// ——— blocks and targets ———

/** Published blocks at their latest version, plus the versions a spec pins. */
export async function builderBlocks(spec: PipelineSpec | null): Promise<BuilderBlock[]> {
  const store = getDataStore().ciBlocks;
  const records = (await store.list()).filter((record) => record.latestVersion > 0);
  const wanted = new Map<string, Set<number>>();
  for (const record of records) wanted.set(record.key, new Set([record.latestVersion]));
  for (const step of spec ? [...spec.checks, ...spec.environments.flatMap((e) => e.steps)] : []) {
    wanted.get(step.block)?.add(step.version);
  }
  const out: BuilderBlock[] = [];
  for (const record of records) {
    for (const version of [...(wanted.get(record.key) ?? [])].sort((a, b) => b - a)) {
      const stored = await store.getVersion(record.id, version);
      const definition = stored ? readBlockDefinition(stored.definition) : null;
      if (definition?.ok) {
        out.push({
          key: record.key,
          name: record.name,
          description: record.description,
          version,
          definition: definition.value,
        });
      }
    }
  }
  return out;
}

/** Targets with the runners the service accounts read; without them when those cannot be read. */
export async function builderTargets(): Promise<CheckTarget[]> {
  const page = await targetsPage();
  if ('error' in page) {
    return (await listTargets()).map((t) => ({ name: t.name, labels: t.labels, runners: [] }));
  }
  return page.targets.map((t) => ({
    name: t.name,
    labels: t.labels,
    runners: [...t.runners.bitbucket, ...t.runners.github],
  }));
}

// ——— what the host says ———

interface HostRead {
  facts: HostFacts;
  files: string[];
  unread: string[];
  branches: HostBranch[];
}

interface Caller {
  subject: string;
  origin: string;
}

const names = (list: { key: string }[]) => list.map((v) => v.key);

async function readBitbucket(
  caller: Caller,
  project: CodeRepoProject,
  lastWritten: string | null
): Promise<HostRead> {
  const auth = bitbucketAuthOf(caller);
  const { fullName, branch } = project.repo;
  const base = repoBase(fullName) ?? '';
  const adapter = bitbucketHostAdapter(caller);
  const [variables, environments, branches, file, source] = await Promise.all([
    listVariables(auth, variablesPath(base, undefined)),
    readBitbucketEnvironments(auth, base),
    adapter.listBranches(fullName),
    readPipelineConfigFile(auth, fullName, branch),
    listBitbucketSource(auth, fullName, branch, ''),
  ]);
  const unread = [
    ...(variables.ok ? [] : [`Variables: ${variables.error}`]),
    ...(environments.error ? [`Deployment environments: ${environments.error}`] : []),
    ...(branches.ok ? [] : [`Branches: ${branches.error}`]),
    ...(file.ok ? [] : [`${PIPELINE_FILE.bitbucket}: ${file.error}`]),
  ];
  return {
    facts: {
      host: 'bitbucket',
      branch,
      repoVariables: variables.ok ? names(variables.variables) : null,
      environments: environments.error
        ? null
        : environments.environments.map((e) => ({ name: e.name, variables: names(e.variables) })),
      branches: branches.ok ? branches.branches.map((b) => b.name) : null,
      existingFile: file.ok ? file.text : null,
      lastWritten,
    },
    files: source.ok ? source.entries.filter((e) => e.kind === 'file').map((e) => e.path) : [],
    unread,
    branches: branches.ok ? branches.branches : [],
  };
}

async function readGithub(
  caller: Caller,
  project: CodeRepoProject,
  lastWritten: string | null
): Promise<HostRead> {
  const auth = githubAuthOf(caller);
  const { fullName, branch } = project.repo;
  const adapter = githubHostAdapter(caller);
  const [setup, branches, file, source] = await Promise.all([
    readActionsSetup(auth, fullName, branch, { readConfig: true, runs: 1 }),
    adapter.listBranches(fullName),
    readWorkflowFile(auth, fullName, branch, WORKFLOW_NAME),
    listGithubSource(auth, fullName, branch, ''),
  ]);
  const s = setup.ok ? setup.setup : null;
  const repoVariables =
    s && !s.variablesError && !s.secretsError ? [...names(s.variables), ...names(s.secrets)] : null;
  const unread = [
    ...(!setup.ok ? [`Actions: ${setup.error}`] : []),
    ...(s?.variablesError ? [`Variables: ${s.variablesError}`] : []),
    ...(s?.secretsError ? [`Secrets: ${s.secretsError}`] : []),
    ...(s?.environmentsError ? [`Environments: ${s.environmentsError}`] : []),
    ...(branches.ok ? [] : [`Branches: ${branches.error}`]),
    ...(file.ok ? [] : [`${PIPELINE_FILE.github}: ${file.error}`]),
  ];
  return {
    facts: {
      host: 'github',
      branch,
      repoVariables,
      environments:
        s && !s.environmentsError
          ? s.environments.map((e) => ({
              name: e.name,
              variables: [...names(e.variables), ...names(e.secrets)],
            }))
          : null,
      branches: branches.ok ? branches.branches.map((b) => b.name) : null,
      existingFile: file.ok ? file.text : null,
      lastWritten,
    },
    files: source.ok ? source.entries.filter((e) => e.kind === 'file').map((e) => e.path) : [],
    unread,
    branches: branches.ok ? branches.branches : [],
  };
}

function readHost(
  host: Host,
  caller: Caller,
  project: CodeRepoProject,
  lastWritten: string | null
) {
  return host === 'github'
    ? readGithub(caller, project, lastWritten)
    : readBitbucket(caller, project, lastWritten);
}

// ——— the page ———

export async function builderPage(caller: Caller, project: CodeRepoProject): Promise<BuilderPage> {
  const host = hostOf(project.repo.provider) ?? 'bitbucket';
  const saved = await getDataStore().ciPipelines.get(project.id);
  const read = saved && saved.host === host ? readPipelineSpec(saved.spec) : null;
  const savedSpec = read?.ok ? read.value : null;
  const [blocks, targets, hostRead] = await Promise.all([
    builderBlocks(savedSpec),
    builderTargets(),
    readHost(host, caller, project, saved?.writtenText ?? null),
  ]);
  const latest = blocks.filter(
    (b) => !blocks.some((other) => other.key === b.key && other.version > b.version)
  );
  const suggestion = suggestPipeline({
    host,
    files: hostRead.files,
    branch: project.repo.branch,
    repoName: project.repo.fullName.split('/').pop() ?? project.name,
    blocks: latest,
    targets,
  });
  return {
    host,
    file: PIPELINE_FILE[host],
    spec: savedSpec ?? suggestion.spec,
    suggested: savedSpec === null,
    found: suggestion.found,
    blocks,
    targets,
    facts: hostRead.facts,
    unread: hostRead.unread,
    pullRequestUrl: saved?.pullRequestUrl ?? null,
    report: reportTo(caller.origin),
  };
}

export async function savePipeline(
  project: CodeRepoProject,
  spec: PipelineSpec,
  subject: string
): Promise<void> {
  const host = hostOf(project.repo.provider) ?? 'bitbucket';
  await getDataStore().ciPipelines.save(project.id, { host, spec, updatedBy: subject });
  // GitHub's tokens name the repository as owner/name; Bitbucket's by a UUID
  // only Bitbucket knows, read when the pull request opens (openBitbucket).
  if (host === 'github') {
    await getDataStore().ciPipelines.setRepoKey(project.id, project.repo.fullName.toLowerCase());
  }
}

// ——— the pull request ———

/** The pull request's title and description: what deploys where once it merges. */
export function pullRequestText(
  spec: PipelineSpec,
  blockName: (key: string) => string,
  host: Host,
  replaces: boolean
): { title: string; description: string } {
  const row = (steps: PipelineSpec['checks']) =>
    steps.length > 0
      ? steps.map((s) => `${blockName(s.block)}${s.target ? ` on ${s.target}` : ''}`).join(' → ')
      : 'nothing';
  const lines = [
    `This ${replaces ? 'replaces' : 'adds'} ${PIPELINE_FILE[host]}, built in Renkei from the organization’s blocks.`,
    '',
    `- **${partName(null)}:** ${row(spec.checks)}`,
    ...spec.environments.map(
      (e) => `- **${e.name}**, on merge to \`${e.branch}\`: ${row(e.steps)}`
    ),
    '',
    `Once merged, ${HOST_LABEL[host]} runs it: merging to an environment’s branch deploys that environment.`,
  ];
  return {
    title: `${replaces ? 'Update' : 'Add'} the pipeline built from blocks`,
    description: lines.join('\n'),
  };
}

export type OpenOutcome =
  | { ok: true; url: string; branch: string; updated: boolean; text: string }
  | { ok: false; status: number; error: string; problems?: string[] };

/** A branch name not taken yet: renkei/pipeline, else with the minute it was made. */
export function freshBranch(taken: string[], now: Date): string {
  if (!taken.includes(PIPELINE_BRANCH)) return PIPELINE_BRANCH;
  const stamp = now.toISOString().slice(0, 16).replace(/[-:T]/g, '');
  return `${PIPELINE_BRANCH}-${stamp}`;
}

interface HostWrite {
  caller: Caller;
  project: CodeRepoProject;
  text: string;
  message: string;
  title: string;
  description: string;
  base: string;
  baseSha: string;
  branches: HostBranch[];
  now: Date;
}

async function openBitbucket(write: HostWrite): Promise<OpenOutcome> {
  const auth = bitbucketAuthOf(write.caller);
  const { fullName } = write.project.repo;
  const base = repoBase(fullName);
  if (!base) return { ok: false, status: 400, error: 'The repository name is not usable.' };
  // How Bitbucket's step tokens will name this repository, for the deploy reports.
  const repository = await bbJson(auth, ['repository'], base);
  const uuid = repository.ok ? str(repository.body.uuid) : '';
  if (uuid) await getDataStore().ciPipelines.setRepoKey(write.project.id, bareUuid(uuid));
  const adapter = bitbucketHostAdapter(write.caller);
  const open = await adapter.listPullRequests(fullName, { state: 'open', max: 50 });
  const existing = open.ok
    ? open.pullRequests.find(
        (pr) => pr.sourceBranch.startsWith(PIPELINE_BRANCH) && pr.destinationBranch === write.base
      )
    : undefined;
  const branch =
    existing?.sourceBranch ??
    freshBranch(
      write.branches.map((b) => b.name),
      write.now
    );
  const form = new URLSearchParams();
  form.set(PIPELINE_FILE.bitbucket, write.text);
  form.set('message', write.message);
  form.set('branch', branch);
  // A new branch starts from the project's branch; an open pull request's gains a commit.
  if (!existing) form.set('parents', write.baseSha);
  const committed = await auth.fetch(['repository:write'], `${base}/src`, { method: 'POST', form });
  if (!committed.ok) {
    return {
      ok: false,
      status: 502,
      error: `Bitbucket refused the commit to ${branch}: ${await describeBitbucketFailure(committed)}`,
    };
  }
  if (existing) {
    return { ok: true, url: existing.url, branch, updated: true, text: write.text };
  }
  const pr = await auth.fetch(['pullrequest:write'], `${base}/pullrequests`, {
    method: 'POST',
    json: {
      title: write.title,
      description: write.description,
      source: { branch: { name: branch } },
      destination: { branch: { name: write.base } },
      close_source_branch: true,
    },
  });
  if (!pr.ok) {
    return {
      ok: false,
      status: 502,
      error: `The file is on ${branch}, but Bitbucket refused the pull request: ${await describeBitbucketFailure(pr)}`,
    };
  }
  const body: unknown = await pr.json().catch(() => null);
  const url = str(rec(rec(rec(body).links).html).href);
  const [workspace, slug] = fullName.split('/');
  return {
    ok: true,
    url: url || `https://bitbucket.org/${workspace}/${slug}/pull-requests/${str(rec(body).id)}`,
    branch,
    updated: false,
    text: write.text,
  };
}

async function openGithub(write: HostWrite): Promise<OpenOutcome> {
  const auth = githubAuthOf(write.caller);
  const { fullName } = write.project.repo;
  const target = ownerRepoOf(fullName);
  if (!target) return { ok: false, status: 400, error: 'The repository name is not usable.' };
  const path = `/repos/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.repo)}`;
  const adapter = githubHostAdapter(write.caller);
  const open = await adapter.listPullRequests(fullName, { state: 'open', max: 50 });
  const existing = open.ok
    ? open.pullRequests.find(
        (pr) => pr.sourceBranch.startsWith(PIPELINE_BRANCH) && pr.destinationBranch === write.base
      )
    : undefined;
  const branch =
    existing?.sourceBranch ??
    freshBranch(
      write.branches.map((b) => b.name),
      write.now
    );
  if (!existing) {
    const made = await ghJson(auth, ['repository:write'], `${path}/git/refs`, {
      method: 'POST',
      json: { ref: `refs/heads/${branch}`, sha: write.baseSha },
    });
    if (!made.ok) {
      return {
        ok: false,
        status: 502,
        error: `GitHub refused the branch ${branch}: ${made.error}`,
      };
    }
  }
  const committed = await commitWorkflowFile(
    auth,
    fullName,
    branch,
    WORKFLOW_NAME,
    write.text,
    write.message
  );
  if (!committed.ok) {
    return {
      ok: false,
      status: 502,
      error: `GitHub refused the commit to ${branch}: ${committed.error}`,
    };
  }
  if (existing) return { ok: true, url: existing.url, branch, updated: true, text: write.text };
  const pr = await ghJson(auth, ['pullrequest:write'], `${path}/pulls`, {
    method: 'POST',
    json: { title: write.title, body: write.description, head: branch, base: write.base },
  });
  if (!pr.ok) {
    return {
      ok: false,
      status: 502,
      error: `The file is on ${branch}, but GitHub refused the pull request: ${pr.error}`,
    };
  }
  return {
    ok: true,
    url: str(rec(pr.body).html_url),
    branch,
    updated: false,
    text: write.text,
  };
}

/**
 * Save the pipeline, render it, and put the file in a pull request against
 * the project's branch — a new one, or a commit on the builder's own while
 * it is open. Nothing is written when the file cannot be rendered.
 */
export async function openPipelinePullRequest(
  caller: Caller,
  project: CodeRepoProject,
  spec: PipelineSpec,
  now: Date
): Promise<OpenOutcome> {
  const host = hostOf(project.repo.provider);
  if (!host) return { ok: false, status: 409, error: 'The repository is on neither host.' };
  const [blocks, targets] = await Promise.all([builderBlocks(spec), builderTargets()]);
  const rendered = renderPipeline(spec, {
    host,
    block: (key, version) => blocks.find((b) => b.key === key && b.version === version) ?? null,
    target: (name) => targets.find((t) => t.name === name)?.labels ?? null,
    report: reportTo(caller.origin),
  });
  if (!rendered.ok) {
    return {
      ok: false,
      status: 400,
      error: 'The file cannot be written yet.',
      problems: rendered.errors,
    };
  }
  await savePipeline(project, spec, caller.subject);
  const saved = await getDataStore().ciPipelines.get(project.id);
  const read = await readHost(host, caller, project, saved?.writtenText ?? null);
  const base = project.repo.branch;
  const baseSha = read.branches.find((b) => b.name === base)?.headSha ?? '';
  if (!baseSha) {
    return {
      ok: false,
      status: 409,
      error: `${HOST_LABEL[host]} did not list the branch ${base}, so there is nothing to open the pull request against.`,
    };
  }
  const nameOf = (key: string) => blocks.find((b) => b.key === key)?.name ?? key;
  const text = pullRequestText(spec, nameOf, host, read.facts.existingFile !== null);
  const write: HostWrite = {
    caller,
    project,
    text: rendered.value,
    message: `${text.title} (Renkei)`,
    title: text.title,
    description: text.description,
    base,
    baseSha,
    branches: read.branches,
    now,
  };
  const outcome = host === 'github' ? await openGithub(write) : await openBitbucket(write);
  if (outcome.ok) {
    await getDataStore().ciPipelines.markWritten(project.id, {
      text: outcome.text,
      pullRequestUrl: outcome.url,
    });
  }
  return outcome;
}
