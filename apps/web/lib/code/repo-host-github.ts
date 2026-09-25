/**
 * The GitHub half of RepoHostAdapter (repo-host.ts) — the same core
 * calls github_list_pull_requests/github_get_pull_request/etc. make
 * (lib/mcp-tools/github/pullrequests.ts, repositories.ts, actions.ts),
 * lifted into plain functions callable outside the MCP tool wrapper —
 * the same move lib/code/github-browse.ts already made for repo/README
 * reads.
 */

import { githubAuthOf } from './github-browse';
import { arr, ghJson, num, prUrl, rec, runUrl, str } from '../mcp-tools/github/client';
import type { GitHubAuth } from '../mcp-tools/github/github-auth';
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

function repoPath(owner: string, repo: string): string {
  return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
}

function ownerRepo(fullName: string): { owner: string; repo: string } | null {
  const [owner, repo] = fullName.split('/');
  if (!owner || !repo) return null;
  return { owner, repo };
}

function prState(pr: Record<string, unknown>): HostPullRequestState {
  if (str(pr.merged_at)) return 'merged';
  return str(pr.state) === 'closed' ? 'closed' : 'open';
}

function pullRequestOf(owner: string, repo: string, pr: Record<string, unknown>): HostPullRequest {
  return {
    number: Number(num(pr.number)) || 0,
    title: str(pr.title),
    state: prState(pr),
    draft: pr.draft === true,
    sourceBranch: str(rec(pr.head).ref),
    destinationBranch: str(rec(pr.base).ref),
    author: str(rec(pr.user).login),
    updatedAt: str(pr.updated_at),
    url: prUrl(owner, repo, str(num(pr.number))),
  };
}

/** GitHub Actions' status/conclusion pair, folded into one normalized state. */
function runState(status: string, conclusion: string): HostPipelineState {
  if (status && status !== 'completed') return 'running';
  if (conclusion === 'success') return 'success';
  if (conclusion === 'failure' || conclusion === 'timed_out' || conclusion === 'action_required')
    return 'failure';
  if (!conclusion) return 'pending';
  return 'other';
}

export function githubHostAdapter(context: RepoHostContext): RepoHostAdapter {
  const auth: GitHubAuth = githubAuthOf(context);
  const scopes = ['repository'] as const;

  return {
    async listBranches(fullName) {
      const target = ownerRepo(fullName);
      if (!target) return { ok: false, error: 'The repository name is not usable.' };
      const result = await ghJson(
        auth,
        scopes,
        `${repoPath(target.owner, target.repo)}/branches?per_page=100`
      );
      if (!result.ok) return result;
      const branches: HostBranch[] = arr(result.body).map((branch) => ({
        name: str(branch.name),
        headSha: str(rec(branch.commit).sha),
      }));
      return { ok: true, branches };
    },

    async listPullRequests(fullName, options) {
      const target = ownerRepo(fullName);
      if (!target) return { ok: false, error: 'The repository name is not usable.' };
      const max = options?.max ?? 20;
      const state = options?.state ?? 'open';
      const result = await ghJson(
        auth,
        scopes,
        `${repoPath(target.owner, target.repo)}/pulls?state=${state}&sort=updated&direction=desc&per_page=${max}`
      );
      if (!result.ok) return result;
      const pullRequests = arr(result.body).map((pr) => pullRequestOf(target.owner, target.repo, pr));
      return { ok: true, pullRequests, hasMore: result.hasMore };
    },

    async getPullRequest(fullName, number) {
      const target = ownerRepo(fullName);
      if (!target) return { ok: false, error: 'The repository name is not usable.' };
      const base = `${repoPath(target.owner, target.repo)}/pulls/${number}`;
      const prResult = await ghJson(auth, scopes, base);
      if (!prResult.ok) return prResult;
      const pr = rec(prResult.body);
      let checksState: string | null = null;
      const headSha = str(rec(pr.head).sha);
      if (headSha) {
        const status = await ghJson(auth, scopes, `${repoPath(target.owner, target.repo)}/commits/${headSha}/status`);
        if (status.ok) checksState = str(rec(status.body).state) || null;
      }
      const pullRequest: HostPullRequestDetail = {
        ...pullRequestOf(target.owner, target.repo, pr),
        description: str(pr.body),
        checksState,
      };
      return { ok: true, pullRequest };
    },

    async mergePullRequest(fullName, number) {
      const target = ownerRepo(fullName);
      if (!target) return { ok: false, error: 'The repository name is not usable.' };
      const result = await ghJson(
        auth,
        scopes,
        `${repoPath(target.owner, target.repo)}/pulls/${number}/merge`,
        { method: 'PUT' }
      );
      if (!result.ok) return result;
      return { ok: true, url: prUrl(target.owner, target.repo, number) };
    },

    async listCommits(fullName, options) {
      const target = ownerRepo(fullName);
      if (!target) return { ok: false, error: 'The repository name is not usable.' };
      const max = options?.max ?? 20;
      const parts = [`per_page=${max}`];
      if (options?.ref) parts.push(`sha=${encodeURIComponent(options.ref)}`);
      const result = await ghJson(
        auth,
        scopes,
        `${repoPath(target.owner, target.repo)}/commits?${parts.join('&')}`
      );
      if (!result.ok) return result;
      const commits: HostCommit[] = arr(result.body).map((commit) => {
        const inner = rec(commit.commit);
        const author = rec(inner.author);
        const sha = str(commit.sha);
        return {
          sha,
          message: str(inner.message).split('\n', 1)[0] ?? '',
          author: str(rec(commit.author).login) || str(author.name),
          date: str(author.date),
          url: `https://github.com/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.repo)}/commit/${sha}`,
        };
      });
      return { ok: true, commits, hasMore: result.hasMore };
    },

    async listPipelineRuns(fullName, options) {
      const target = ownerRepo(fullName);
      if (!target) return { ok: false, error: 'The repository name is not usable.' };
      const max = options?.max ?? 20;
      const parts = [`per_page=${max}`];
      if (options?.branch) parts.push(`branch=${encodeURIComponent(options.branch)}`);
      const result = await ghJson(
        auth,
        scopes,
        `${repoPath(target.owner, target.repo)}/actions/runs?${parts.join('&')}`
      );
      if (!result.ok) return result;
      const runs: HostPipelineRun[] = arr(rec(result.body).workflow_runs).map((run) => ({
        id: num(run.id),
        state: runState(str(run.status), str(run.conclusion)),
        ref: str(run.head_branch),
        url: runUrl(target.owner, target.repo, num(run.id)),
        startedAt: str(run.run_started_at),
      }));
      return { ok: true, runs };
    },
  };
}
