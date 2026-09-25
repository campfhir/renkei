/**
 * One interface over a code project's repository host — GitHub or
 * Bitbucket — so a route or component asks for branches, pull requests,
 * commits or pipeline runs once and gets the same shape back regardless
 * of which host the project points at. `hostAdapterFor` picks the
 * implementation (repo-host-github.ts / repo-host-bitbucket.ts) by
 * `chat_projects.repo_provider`; everything above this file is
 * provider-blind.
 *
 * Every method follows the "hide if no token or API failure" shape the
 * rest of the Code pages already use (see lib/code/github-browse.ts):
 * `{ok: true, ...}` or `{ok: false, error}`, never a thrown exception.
 */

import { githubHostAdapter } from './repo-host-github';
import { bitbucketHostAdapter } from './repo-host-bitbucket';

export interface RepoHostContext {
  tenantId: string;
  subject: string;
  origin: string;
}

export interface HostBranch {
  name: string;
  headSha: string;
}

export type HostPullRequestState = 'open' | 'merged' | 'declined' | 'closed';

export interface HostPullRequest {
  number: number;
  title: string;
  state: HostPullRequestState;
  draft: boolean;
  sourceBranch: string;
  destinationBranch: string;
  author: string;
  updatedAt: string;
  url: string;
}

export interface HostPullRequestDetail extends HostPullRequest {
  description: string;
  /** The combined CI/checks state for the head commit, when the host reports one. */
  checksState: string | null;
}

export interface HostCommit {
  sha: string;
  message: string;
  author: string;
  date: string;
  url: string;
}

export type HostPipelineState = 'success' | 'failure' | 'running' | 'pending' | 'other';

export interface HostPipelineRun {
  id: string;
  state: HostPipelineState;
  /** The branch (or ref) it ran on. */
  ref: string;
  url: string;
  startedAt: string;
}

export interface RepoHostAdapter {
  listBranches(
    fullName: string
  ): Promise<{ ok: true; branches: HostBranch[] } | { ok: false; error: string }>;
  listPullRequests(
    fullName: string,
    options?: { state?: 'open' | 'closed' | 'all'; max?: number }
  ): Promise<{ ok: true; pullRequests: HostPullRequest[]; hasMore: boolean } | { ok: false; error: string }>;
  getPullRequest(
    fullName: string,
    number: number
  ): Promise<{ ok: true; pullRequest: HostPullRequestDetail } | { ok: false; error: string }>;
  mergePullRequest(
    fullName: string,
    number: number
  ): Promise<{ ok: true; url: string } | { ok: false; error: string }>;
  listCommits(
    fullName: string,
    options?: { ref?: string; max?: number }
  ): Promise<{ ok: true; commits: HostCommit[]; hasMore: boolean } | { ok: false; error: string }>;
  listPipelineRuns(
    fullName: string,
    options?: { branch?: string; max?: number }
  ): Promise<{ ok: true; runs: HostPipelineRun[] } | { ok: false; error: string }>;
}

/** The adapter for one project's host, given the caller's own identity. */
export function hostAdapterFor(
  provider: string,
  context: RepoHostContext
): RepoHostAdapter | null {
  if (provider === 'github') return githubHostAdapter(context);
  if (provider === 'bitbucket') return bitbucketHostAdapter(context);
  return null;
}
