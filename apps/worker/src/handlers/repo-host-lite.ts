/**
 * The minimal GitHub/Bitbucket REST calls the PR-pipeline-events worker
 * needs: re-fetch a run/pipeline's authoritative conclusion (never trust
 * the webhook payload's own — apps/web/app/api/webhooks/*'s same
 * rationale) and merge a pull request. A small, self-contained subset
 * of apps/web/lib/code/repo-host.ts's RepoHostAdapter — this worker
 * cannot import apps/web's Next.js internals, so this is its own copy
 * of just what it needs, against the same REST APIs.
 */

export type PipelineConclusion = 'success' | 'failure' | 'running' | 'pending' | 'other';

interface RepoTarget {
  fullName: string;
}

function rec(value: unknown): Record<string, unknown> {
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function arr(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function githubHeaders(accessToken: string): Record<string, string> {
  return {
    Authorization: `Bearer ${accessToken}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
}

export async function getGitHubWorkflowRunConclusion(
  accessToken: string,
  target: RepoTarget,
  runId: string
): Promise<PipelineConclusion | null> {
  const response = await fetch(`https://api.github.com/repos/${target.fullName}/actions/runs/${runId}`, {
    headers: githubHeaders(accessToken),
  });
  if (!response.ok) return null;
  const body: unknown = await response.json().catch(() => null);
  const record = rec(body);
  const status = typeof record.status === 'string' ? record.status : '';
  const conclusion = typeof record.conclusion === 'string' ? record.conclusion : '';
  if (status && status !== 'completed') return 'running';
  if (conclusion === 'success') return 'success';
  if (conclusion === 'failure' || conclusion === 'timed_out' || conclusion === 'action_required') {
    return 'failure';
  }
  if (!conclusion) return 'pending';
  return 'other';
}

export async function mergeGitHubPullRequest(
  accessToken: string,
  target: RepoTarget,
  prNumber: number
): Promise<{ ok: true; url: string } | { ok: false; error: string }> {
  const response = await fetch(
    `https://api.github.com/repos/${target.fullName}/pulls/${prNumber}/merge`,
    { method: 'PUT', headers: githubHeaders(accessToken) }
  );
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    return { ok: false, error: `GitHub API ${response.status}: ${text.slice(0, 300)}` };
  }
  return { ok: true, url: `https://github.com/${target.fullName}/pull/${prNumber}` };
}

function bitbucketHeaders(accessToken: string): Record<string, string> {
  return { Authorization: `Bearer ${accessToken}` };
}

/**
 * Bitbucket has no single "get this pipeline" call keyed by commit —
 * pipelines are their own resource, keyed by uuid, and a webhook
 * delivery about a PR names a commit, not a pipeline uuid. Build
 * statuses (what Pipelines itself posts back to the commit as it runs)
 * are the resource actually keyed by commit, so this reads those
 * instead: any INPROGRESS status keeps the PR "running"; failing that,
 * any FAILED status is the conclusion; failing that, one or more
 * SUCCESSFUL statuses (and none pending) is "success". No statuses at
 * all reads as "pending" rather than guessing.
 */
export async function getBitbucketCommitStatusConclusion(
  accessToken: string,
  target: RepoTarget,
  commitHash: string
): Promise<PipelineConclusion | null> {
  const response = await fetch(
    `https://api.bitbucket.org/2.0/repositories/${target.fullName}/commit/${encodeURIComponent(commitHash)}/statuses?pagelen=50`,
    { headers: bitbucketHeaders(accessToken) }
  );
  if (!response.ok) return null;
  const body: unknown = await response.json().catch(() => null);
  const states = arr(rec(body).values).map((value) => {
    const state = rec(value).state;
    return typeof state === 'string' ? state.toUpperCase() : '';
  });
  if (states.length === 0) return 'pending';
  if (states.some((state) => state === 'INPROGRESS')) return 'running';
  if (states.some((state) => state === 'FAILED' || state === 'STOPPED')) return 'failure';
  if (states.every((state) => state === 'SUCCESSFUL')) return 'success';
  return 'other';
}

export async function mergeBitbucketPullRequest(
  accessToken: string,
  target: RepoTarget,
  prNumber: number
): Promise<{ ok: true; url: string } | { ok: false; error: string }> {
  const response = await fetch(
    `https://api.bitbucket.org/2.0/repositories/${target.fullName}/pullrequests/${prNumber}/merge`,
    { method: 'POST', headers: bitbucketHeaders(accessToken) }
  );
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    return { ok: false, error: `Bitbucket API ${response.status}: ${text.slice(0, 300)}` };
  }
  return { ok: true, url: `https://bitbucket.org/${target.fullName}/pull-requests/${prNumber}` };
}
