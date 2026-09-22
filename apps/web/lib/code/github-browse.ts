/**
 * Reading GitHub for the Code pages with the signed-in person's own
 * grant: the accounts (organizations/user accounts) Renkei's GitHub App
 * is installed on for them, an account's repositories (or searched by
 * name), a repository's README, and — for the project page's tree and
 * the code pane, before any chat has cloned — one directory's entries
 * or one file's content on the project's branch. Nothing here writes
 * existing content except creating a brand-new repository for the
 * new-project form's "Create new repository" tab, and every call is
 * bounded — a picker and a project page, not a mirror.
 *
 * GitHub has no grouping above a repository the way Bitbucket has
 * projects — repositories sit directly under an account — so this
 * module's shape is the Bitbucket browser's minus that one layer.
 */

import { getOrigin } from '@/lib/get-origin';
import type { NextRequest } from 'next/server';
import { oauthGitHubAuth, type GitHubAuth } from '@/lib/mcp-tools/github/github-auth';
import { arr, ghJson, ghRawText, rec, str } from '@/lib/mcp-tools/github/client';
import type { MCPToolContext } from '@/lib/mcp-tools/common';
import type { RepoChoice, SourceEntry } from './bitbucket-browse';

const README_MAX_CHARS = 60_000;
const README_NAMES = ['README.md', 'readme.md', 'README.MD', 'Readme.md', 'README', 'README.txt'];
const SOURCE_FILE_MAX_CHARS = 200_000;

/** repos/{owner}/{repo} path, both halves encoded. */
function repoBase(owner: string, repo: string): string {
  return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
}

/** The branch to read: the one given, else the repository's default branch. */
async function refOf(auth: GitHubAuth, base: string, branch: string): Promise<string | null> {
  if (branch) return branch;
  const info = await ghJson(auth, ['repository'], base);
  if (!info.ok) return null;
  return str(rec(info.body).default_branch) || null;
}

export interface GitHubAccount {
  slug: string;
  name: string;
}

/** The auth for one signed-in person, from a route's request. */
export async function githubAuthFor(
  request: NextRequest,
  tenantId: string,
  subject: string
): Promise<GitHubAuth> {
  const origin = await getOrigin(request);
  return githubAuthOf({ tenantId, subject, origin: origin.ok ? origin.val : '' });
}

/** The auth for one person outside a request (a server page). */
export function githubAuthOf(context: { tenantId: string; subject: string; origin: string }): GitHubAuth {
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
  return oauthGitHubAuth(context as MCPToolContext);
}

/** The accounts (organizations/user accounts) Renkei's GitHub App is installed on for this person. */
export async function listAccounts(
  auth: GitHubAuth
): Promise<{ ok: true; accounts: GitHubAccount[] } | { ok: false; error: string }> {
  const listed = await ghJson(auth, ['repository'], '/user/installations?per_page=100');
  if (!listed.ok) return listed;
  const accounts = arr(rec(listed.body).installations)
    .map((installation) => str(rec(installation.account).login))
    .filter(Boolean)
    .map((login) => ({ slug: login, name: login }));
  return { ok: true, accounts };
}

/**
 * Repositories: of one account, or searched by name across every
 * account Renkei's App is installed on for this person.
 */
export async function listRepositories(
  auth: GitHubAuth,
  filter: { account?: string; query?: string }
): Promise<{ ok: true; repos: RepoChoice[] } | { ok: false; error: string }> {
  let accountSlugs: string[];
  if (filter.account) accountSlugs = [filter.account];
  else {
    const accounts = await listAccounts(auth);
    if (!accounts.ok) return accounts;
    accountSlugs = accounts.accounts.map((account) => account.slug);
  }
  const installations = await ghJson(auth, ['repository'], '/user/installations?per_page=100');
  if (!installations.ok) return installations;
  const byLogin = new Map(
    arr(rec(installations.body).installations).map((installation) => [
      str(rec(installation.account).login).toLowerCase(),
      Number(installation.id),
    ])
  );
  const query = (filter.query ?? '').toLowerCase();
  const repos: RepoChoice[] = [];
  for (const slug of accountSlugs) {
    const installationId = byLogin.get(slug.toLowerCase());
    if (!installationId) {
      if (filter.account) return { ok: false, error: `No installation covers "${slug}".` };
      continue;
    }
    const listed = await ghJson(
      auth,
      ['repository'],
      `/user/installations/${installationId}/repositories?per_page=100`
    );
    if (!listed.ok) {
      if (filter.account) return listed;
      continue;
    }
    for (const repo of arr(rec(listed.body).repositories)) {
      const fullName = str(repo.full_name);
      if (!fullName) continue;
      if (query && !str(repo.name).toLowerCase().includes(query)) continue;
      repos.push({
        fullName,
        name: str(repo.name) || fullName.split('/').pop() || fullName,
        // GitHub has no grouping layer above a repository.
        projectKey: null,
        mainBranch: str(repo.default_branch) || null,
        updatedOn: str(repo.updated_at) || null,
      });
    }
  }
  repos.sort((a, b) => (b.updatedOn ?? '').localeCompare(a.updatedOn ?? ''));
  return { ok: true, repos };
}

/**
 * A brand-new, empty repository under an account — for the new-project
 * form's "Create new repository" tab. The repository starts private
 * with nothing in it, so the caller still gets no branch back — the
 * first chat's clone is what puts anything on it.
 */
export async function createRepository(
  auth: GitHubAuth,
  input: { account: string; name: string }
): Promise<{ ok: true; repo: RepoChoice } | { ok: false; error: string }> {
  const account = input.account.trim();
  const name = input.name.trim();
  if (!account) return { ok: false, error: 'Pick an account.' };
  if (!name) return { ok: false, error: 'Give the repository a name.' };
  const installations = await ghJson(auth, ['repository'], '/user/installations?per_page=100');
  if (!installations.ok) return installations;
  const match = arr(rec(installations.body).installations).find(
    (installation) => str(rec(installation.account).login).toLowerCase() === account.toLowerCase()
  );
  if (!match) return { ok: false, error: `No installation covers "${account}".` };
  const isOrg = str(rec(match.account).type).toLowerCase() === 'organization';
  const created = await ghJson(
    auth,
    ['repository:admin'],
    isOrg ? `/orgs/${encodeURIComponent(account)}/repos` : '/user/repos',
    { method: 'POST', json: { name, private: true } }
  );
  if (!created.ok) return created;
  const repo = rec(created.body);
  return {
    ok: true,
    repo: {
      fullName: str(repo.full_name) || `${account}/${name}`,
      name: str(repo.name) || name,
      projectKey: null,
      mainBranch: str(repo.default_branch) || null,
      updatedOn: str(repo.updated_at) || null,
    },
  };
}

/**
 * The repository's README on a branch (or the repository's default
 * branch), as Markdown text — or null when there is none, the branch is
 * unknown, or GitHub cannot be read. Best effort: a project page never
 * fails for want of a README.
 */
export async function readReadme(
  auth: GitHubAuth,
  fullName: string,
  branch: string
): Promise<{ path: string; text: string } | null> {
  const [owner, repo] = fullName.split('/');
  if (!owner || !repo) return null;
  const base = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  let ref = branch;
  if (!ref) {
    const info = await ghJson(auth, ['repository'], base);
    if (!info.ok) return null;
    ref = str(rec(info.body).default_branch);
    if (!ref) return null;
  }
  for (const name of README_NAMES) {
    const file = await ghRawText(
      auth,
      ['repository'],
      `${base}/contents/${encodeURIComponent(name)}?ref=${encodeURIComponent(ref)}`,
      'application/vnd.github.raw+json'
    );
    if (file.ok && file.text.trim()) {
      return { path: name, text: file.text.slice(0, README_MAX_CHARS) };
    }
  }
  return null;
}

/**
 * One directory of the repository as GitHub has it on a branch — the
 * tree a project page shows before anything is cloned. Directories
 * first, then files with sizes.
 */
export async function listSource(
  auth: GitHubAuth,
  fullName: string,
  branch: string,
  path: string
): Promise<{ ok: true; entries: SourceEntry[]; ref: string } | { ok: false; error: string }> {
  const [owner, repo] = fullName.split('/');
  if (!owner || !repo) return { ok: false, error: 'The repository name is not usable.' };
  const base = repoBase(owner, repo);
  const ref = await refOf(auth, base, branch);
  if (!ref) return { ok: false, error: 'The repository’s branch could not be read.' };
  const clean = path.replace(/^\/+|\/+$/g, '');
  const encoded = clean
    ? clean
        .split('/')
        .map((part) => encodeURIComponent(part))
        .join('/')
    : '';
  const listed = await ghJson(
    auth,
    ['repository'],
    `${base}/contents/${encoded}?ref=${encodeURIComponent(ref)}`
  );
  if (!listed.ok) return listed;
  const body = listed.body;
  // A single-file path answers one object, not an array — not a
  // directory this tree can list.
  if (!Array.isArray(body)) return { ok: false, error: 'That path is a file, not a directory.' };
  const entries: SourceEntry[] = arr(body)
    .map((entry) => ({
      path: str(entry.path),
      kind: str(entry.type) === 'dir' ? ('dir' as const) : ('file' as const),
      sizeBytes: typeof entry.size === 'number' ? entry.size : null,
    }))
    .filter((entry) => entry.path);
  entries.sort((a, b) => {
    const rank = (kind: string) => (kind === 'dir' ? 0 : 1);
    return rank(a.kind) - rank(b.kind) || a.path.localeCompare(b.path);
  });
  return { ok: true, entries, ref };
}

/**
 * One file's content on a branch (or the repository's default branch),
 * as raw text — or an error when it cannot be read. Binary files answer
 * `binary: true` with no text (GitHub's raw media type serves them
 * as-is, and a null byte is the same signal Bitbucket's reader uses).
 */
export async function readSourceFile(
  auth: GitHubAuth,
  fullName: string,
  branch: string,
  path: string
): Promise<
  | { ok: true; text: string; ref: string; truncated: boolean; binary: boolean }
  | { ok: false; error: string }
> {
  const [owner, repo] = fullName.split('/');
  if (!owner || !repo) return { ok: false, error: 'The repository name is not usable.' };
  const base = repoBase(owner, repo);
  const ref = await refOf(auth, base, branch);
  if (!ref) return { ok: false, error: 'The repository’s branch could not be read.' };
  const encoded = path
    .split('/')
    .map((part) => encodeURIComponent(part))
    .join('/');
  const file = await ghRawText(
    auth,
    ['repository'],
    `${base}/contents/${encoded}?ref=${encodeURIComponent(ref)}`,
    'application/vnd.github.raw+json'
  );
  if (!file.ok) return file;
  if (file.text.includes('\0')) return { ok: true, text: '', ref, truncated: false, binary: true };
  const truncated = file.text.length > SOURCE_FILE_MAX_CHARS;
  return {
    ok: true,
    text: truncated ? file.text.slice(0, SOURCE_FILE_MAX_CHARS) : file.text,
    ref,
    truncated,
    binary: false,
  };
}
