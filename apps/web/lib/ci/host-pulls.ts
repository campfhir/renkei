/**
 * What promoting an environment asks of a repository's host, with the
 * person's own grant: the commits one branch has that another does not
 * (what merging would bring), and opening the pull request between them.
 * Merging goes through the host adapter (repo-host.ts), as the Pulls page's
 * does.
 */

import type { Host } from '@renkei/ci-blocks';
import { isRecord } from '@renkei/guards';
import { bitbucketAuthOf } from '@/lib/code/bitbucket-browse';
import { githubAuthOf } from '@/lib/code/github-browse';
import { bbJson, describeBitbucketFailure } from '@/lib/mcp-tools/bitbucket/client';
import { arr, ghJson, rec, str } from '@/lib/mcp-tools/github/client';

export interface Caller {
  subject: string;
  origin: string;
}

export interface AheadCommit {
  sha: string;
  message: string;
  author: string;
}

const MAX_COMMITS = 30;

function parts(fullName: string): [string, string] | null {
  const [owner, name] = fullName.split('/');
  return owner && name ? [encodeURIComponent(owner), encodeURIComponent(name)] : null;
}

/** The commits `from` has that `to` does not, newest first; `more` when there are more than listed. */
export async function commitsAhead(
  host: Host,
  caller: Caller,
  fullName: string,
  from: string,
  to: string
): Promise<
  { ok: true; commits: AheadCommit[]; count: number; more: boolean } | { ok: false; error: string }
> {
  const repo = parts(fullName);
  if (!repo) return { ok: false, error: 'The repository name is not usable.' };
  if (host === 'github') {
    const compared = await ghJson(
      githubAuthOf(caller),
      ['repository'],
      `/repos/${repo[0]}/${repo[1]}/compare/${encodeURIComponent(to)}...${encodeURIComponent(from)}`
    );
    if (!compared.ok) return compared;
    const body = rec(compared.body);
    const commits = arr(body.commits)
      .map((c) => ({
        sha: str(c.sha),
        message: str(rec(c.commit).message).split('\n', 1)[0] ?? '',
        author: str(rec(c.author).login) || str(rec(rec(c.commit).author).name),
      }))
      .reverse();
    const count = typeof body.ahead_by === 'number' ? body.ahead_by : commits.length;
    return { ok: true, commits: commits.slice(0, MAX_COMMITS), count, more: count > MAX_COMMITS };
  }
  const listed = await bbJson(
    bitbucketAuthOf(caller),
    ['repository'],
    `/repositories/${repo[0]}/${repo[1]}/commits?include=${encodeURIComponent(from)}&exclude=${encodeURIComponent(to)}&pagelen=${MAX_COMMITS}`
  );
  if (!listed.ok) return listed;
  const values = Array.isArray(listed.body.values) ? listed.body.values.filter(isRecord) : [];
  const commits = values.map((c) => ({
    sha: str(c.hash),
    message: str(c.message).split('\n', 1)[0] ?? '',
    author:
      str(rec(rec(c.author).user).display_name) || str(rec(c.author).raw).replace(/\s*<.*>$/, ''),
  }));
  const more = typeof listed.body.next === 'string';
  return { ok: true, commits, count: commits.length, more };
}

/** Open a pull request from one branch into another; its number and address. */
export async function openPullRequest(
  host: Host,
  caller: Caller,
  fullName: string,
  input: { from: string; to: string; title: string; description: string }
): Promise<{ ok: true; number: number; url: string } | { ok: false; error: string }> {
  const repo = parts(fullName);
  if (!repo) return { ok: false, error: 'The repository name is not usable.' };
  if (host === 'github') {
    const opened = await ghJson(
      githubAuthOf(caller),
      ['pullrequest:write'],
      `/repos/${repo[0]}/${repo[1]}/pulls`,
      {
        method: 'POST',
        json: { title: input.title, body: input.description, head: input.from, base: input.to },
      }
    );
    if (!opened.ok) return opened;
    const body = rec(opened.body);
    const number = typeof body.number === 'number' ? body.number : 0;
    return {
      ok: true,
      number,
      url: str(body.html_url) || `https://github.com/${fullName}/pull/${number}`,
    };
  }
  const response = await bitbucketAuthOf(caller).fetch(
    ['pullrequest:write'],
    `/repositories/${repo[0]}/${repo[1]}/pullrequests`,
    {
      method: 'POST',
      json: {
        title: input.title,
        description: input.description,
        source: { branch: { name: input.from } },
        destination: { branch: { name: input.to } },
        close_source_branch: false,
      },
    }
  );
  if (!response.ok) return { ok: false, error: await describeBitbucketFailure(response) };
  const body: unknown = await response.json().catch(() => null);
  const record = rec(body);
  const number = typeof record.id === 'number' ? record.id : 0;
  return {
    ok: true,
    number,
    url:
      str(rec(rec(record.links).html).href) ||
      `https://bitbucket.org/${fullName}/pull-requests/${number}`,
  };
}
