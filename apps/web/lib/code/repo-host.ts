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

import { GITHUB, ATLASSIAN_BITBUCKET } from '@renkei/provider-grants';
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

/**
 * The adapter for one project's host, given the caller's own identity.
 * `provider` is `chat_projects.repo_provider`, which the project-creation
 * route (api/tenant/[tenantId]/code/projects/route.ts) writes as the
 * provider-grants constant itself — GITHUB ('github') or
 * ATLASSIAN_BITBUCKET ('atlassian-bitbucket'), never the bare word
 * 'bitbucket'. Matching against a literal 'bitbucket' here made every
 * real Bitbucket project's Pulls/Commits card read "host not
 * supported": PipelinesSummary/pipelines-access.ts already checked
 * ATLASSIAN_BITBUCKET directly and worked, which is what hid this.
 */
export function hostAdapterFor(
  provider: string,
  context: RepoHostContext
): RepoHostAdapter | null {
  if (provider === GITHUB) return githubHostAdapter(context);
  if (provider === ATLASSIAN_BITBUCKET) return bitbucketHostAdapter(context);
  return null;
}
