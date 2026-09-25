/**
 * The Bitbucket half of RepoHostAdapter (repo-host.ts) — the same core
 * calls bitbucket_list_pull_requests/bitbucket_get_pull_request/etc.
 * make (lib/mcp-tools/bitbucket/pullrequests.ts, repositories.ts) and
 * the pipeline-run listing bitbucket-pipelines.ts already reads,
 * lifted into plain functions the way lib/code/bitbucket-browse.ts
 * already does for repo/README reads. Bitbucket Pipelines' own
 * configuration (the switch, the YAML, variables, deployment
 * environments) stays entirely in bitbucket-pipelines.ts — that's a
 * person's own gesture on the Pipelines page, not part of this
 * host-agnostic read surface — only the run list normalizes here.
 */

import { bitbucketAuthOf } from './bitbucket-browse';
import { bbJson, num, pipelineUrl, prUrl, rec, str, values } from '../mcp-tools/bitbucket/client';
import type { BitbucketAuth } from '../mcp-tools/bitbucket/bitbucket-auth';
import { repoBase } from './bitbucket-pipelines';
import type {
  HostBranch,
  HostCommit,
  HostPipelineRun,
  HostPipelineState,
  HostPullRequest,
  HostPullRequestDetail,
  HostPullRequestState,
  RepoHostAdapter,
  RepoHostContext,
} from './repo-host';

function workspaceRepo(fullName: string): { workspace: string; repoSlug: string } | null {
  const [workspace, repoSlug] = fullName.split('/');
  if (!workspace || !repoSlug) return null;
  return { workspace, repoSlug };
}

function prState(pr: Record<string, unknown>): HostPullRequestState {
  const state = str(pr.state).toUpperCase();
  if (state === 'MERGED') return 'merged';
  if (state === 'DECLINED' || state === 'SUPERSEDED') return 'declined';
  return 'open';
}

function pullRequestOf(workspace: string, repoSlug: string, pr: Record<string, unknown>): HostPullRequest {
  const id = Number(num(pr.id)) || 0;
  return {
    number: id,
    title: str(pr.title),
    state: prState(pr),
    draft: false,
    sourceBranch: str(rec(rec(pr.source).branch).name),
    destinationBranch: str(rec(rec(pr.destination).branch).name),
    author: str(rec(pr.author).display_name),
    updatedAt: str(pr.updated_on),
    url: prUrl(workspace, repoSlug, id),
  };
}

/** A Bitbucket pipeline run's result/stage, folded into one normalized state. */
function runState(raw: Record<string, unknown>): HostPipelineState {
  const state = rec(raw.state);
  const result = str(rec(state.result).name).toUpperCase();
  const stageName = str(rec(state.stage).name).toUpperCase();
  if (result === 'SUCCESSFUL') return 'success';
  if (result === 'FAILED' || result === 'ERROR') return 'failure';
  if (stageName === 'IN_PROGRESS' || stageName === 'RUNNING') return 'running';
  if (stageName === 'PENDING') return 'pending';
  return 'other';
}

export function bitbucketHostAdapter(context: RepoHostContext): RepoHostAdapter {
  const auth: BitbucketAuth = bitbucketAuthOf(context);
  const scopes = ['repository'] as const;

  return {
    async listBranches(fullName) {
      const target = workspaceRepo(fullName);
      if (!target) return { ok: false, error: 'The repository name is not usable.' };
      const result = await bbJson(
        auth,
        scopes,
        `/repositories/${encodeURIComponent(target.workspace)}/${encodeURIComponent(target.repoSlug)}/refs/branches?pagelen=100&sort=-target.date`
      );
      if (!result.ok) return result;
      const branches: HostBranch[] = values(result.body).map((branch) => ({
        name: str(branch.name),
        headSha: str(rec(branch.target).hash),
      }));
      return { ok: true, branches };
    },

    async listPullRequests(fullName, options) {
      const target = workspaceRepo(fullName);
      if (!target) return { ok: false, error: 'The repository name is not usable.' };
      const max = options?.max ?? 20;
      const state = options?.state === 'closed' ? 'MERGED' : options?.state === 'all' ? undefined : 'OPEN';
      const parts = [`pagelen=${max}`, 'sort=-updated_on', ...(state ? [`state=${state}`] : [])];
      const result = await bbJson(
        auth,
        scopes,
        `/repositories/${encodeURIComponent(target.workspace)}/${encodeURIComponent(target.repoSlug)}/pullrequests?${parts.join('&')}`
      );
      if (!result.ok) return result;
      const pullRequests = values(result.body).map((pr) =>
        pullRequestOf(target.workspace, target.repoSlug, pr)
      );
      return { ok: true, pullRequests, hasMore: typeof result.body.next === 'string' };
    },

    async getPullRequest(fullName, number) {
      const target = workspaceRepo(fullName);
      if (!target) return { ok: false, error: 'The repository name is not usable.' };
      const base = `/repositories/${encodeURIComponent(target.workspace)}/${encodeURIComponent(target.repoSlug)}/pullrequests/${number}`;
      const prResult = await bbJson(auth, scopes, base);
      if (!prResult.ok) return prResult;
      const pr = prResult.body;
      const pullRequest: HostPullRequestDetail = {
        ...pullRequestOf(target.workspace, target.repoSlug, pr),
        description: str(pr.description),
        // Bitbucket reports per-commit build status, not one combined
        // state on the PR itself — left null rather than guessed.
        checksState: null,
      };
      return { ok: true, pullRequest };
    },

    async mergePullRequest(fullName, number) {
      const target = workspaceRepo(fullName);
      if (!target) return { ok: false, error: 'The repository name is not usable.' };
      const result = await bbJson(
        auth,
        scopes,
        `/repositories/${encodeURIComponent(target.workspace)}/${encodeURIComponent(target.repoSlug)}/pullrequests/${number}/merge`,
        { method: 'POST' }
      );
      if (!result.ok) return result;
      return { ok: true, url: prUrl(target.workspace, target.repoSlug, number) };
    },

    async listCommits(fullName, options) {
      const target = workspaceRepo(fullName);
      if (!target) return { ok: false, error: 'The repository name is not usable.' };
      const max = options?.max ?? 20;
      const base = `/repositories/${encodeURIComponent(target.workspace)}/${encodeURIComponent(target.repoSlug)}/commits`;
      const result = await bbJson(
        auth,
        scopes,
        `${base}${options?.ref ? `/${encodeURIComponent(options.ref)}` : ''}?pagelen=${max}`
      );
      if (!result.ok) return result;
      const commits: HostCommit[] = values(result.body).map((commit) => {
        const author = rec(commit.author);
        const hash = str(commit.hash);
        return {
          sha: hash,
          message: str(commit.message).split('\n', 1)[0] ?? '',
          author: str(rec(author.user).display_name) || str(author.raw),
          date: str(commit.date),
          url: `https://bitbucket.org/${encodeURIComponent(target.workspace)}/${encodeURIComponent(target.repoSlug)}/commits/${hash}`,
        };
      });
      return { ok: true, commits, hasMore: typeof result.body.next === 'string' };
    },

    async listPipelineRuns(fullName, options) {
      const base = repoBase(fullName);
      if (!base) return { ok: false, error: 'The repository name is not usable.' };
      const max = options?.max ?? 20;
      const parts = [`pagelen=${max}`, 'sort=-created_on'];
      if (options?.branch) parts.push(`target.branch=${encodeURIComponent(options.branch)}`);
      const result = await bbJson(auth, ['pipeline'], `${base}/pipelines?${parts.join('&')}`);
      if (!result.ok) return result;
      const [workspace, repoSlug] = fullName.split('/');
      const runs: HostPipelineRun[] = values(result.body)
        .map((raw) => {
          const buildNumber = typeof raw.build_number === 'number' ? raw.build_number : null;
          if (buildNumber === null) return null;
          const target = rec(raw.target);
          const run: HostPipelineRun = {
            id: String(buildNumber),
            state: runState(raw),
            ref: str(target.ref_name) || str(rec(target.commit).hash).slice(0, 12),
            url: pipelineUrl(workspace ?? '', repoSlug ?? '', buildNumber),
            startedAt: str(raw.created_on),
          };
          return run;
        })
        .filter((run): run is HostPipelineRun => run !== null);
      return { ok: true, runs };
    },
  };
}
