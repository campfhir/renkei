/**
 * Reading Bitbucket for the Code pages with the signed-in person's own
 * grant: the workspaces they belong to, a workspace's projects, its
 * repositories (by project, or searched by name), and a repository's
 * README. Nothing here writes, and every call is bounded — a picker
 * and a project page, not a mirror.
 */

import { getOrigin } from '@/lib/get-origin';
import type { NextRequest } from 'next/server';
import { oauthBitbucketAuth, type BitbucketAuth } from '@/lib/mcp-tools/bitbucket/bitbucket-auth';
import { bbJson, bbRawText, rec, str, values } from '@/lib/mcp-tools/bitbucket/client';
import { listUserWorkspaces } from '@/lib/mcp-tools/bitbucket/workspaces';
import type { MCPToolContext } from '@/lib/mcp-tools/common';
import { repoSlugFromName } from './repo-slug';

const PAGE = 100;
const README_MAX_CHARS = 60_000;
const README_NAMES = ['README.md', 'readme.md', 'README.MD', 'Readme.md', 'README', 'README.txt'];

export interface BrowseWorkspace {
  slug: string;
  name: string;
}
export interface BrowseProject {
  key: string;
  name: string;
}
export interface RepoChoice {
  fullName: string;
  name: string;
  projectKey: string | null;
  mainBranch: string | null;
  updatedOn: string | null;
}

/** The auth for one signed-in person, from a route's request. */
export async function bitbucketAuthFor(
  request: NextRequest,
  tenantId: string,
  subject: string
): Promise<BitbucketAuth> {
  const origin = await getOrigin(request);
  return bitbucketAuthOf({ tenantId, subject, origin: origin.ok ? origin.val : '' });
}

/** The auth for one person outside a request (a server page). */
export function bitbucketAuthOf(context: {
  tenantId: string;
  subject: string;
  origin: string;
}): BitbucketAuth {
  // The auth only needs the caller's identity and origin; every other
  // field of the tool context is a Jira concern these readers never touch.
  // Scopes are left unknown, so Bitbucket's own 403 is the answer for a
  // connection narrowed away from `repository`.
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
  return oauthBitbucketAuth(context as MCPToolContext);
}

export async function listWorkspaces(
  auth: BitbucketAuth
): Promise<{ ok: true; workspaces: BrowseWorkspace[] } | { ok: false; error: string }> {
  const listed = await listUserWorkspaces(auth, ['account']);
  if (!listed.ok) return listed;
  return {
    ok: true,
    workspaces: listed.workspaces.map(({ slug, name }) => ({ slug, name })),
  };
}

export async function listProjects(
  auth: BitbucketAuth,
  workspace: string
): Promise<{ ok: true; projects: BrowseProject[] } | { ok: false; error: string }> {
  const listed = await bbJson(
    auth,
    ['project'],
    `/workspaces/${encodeURIComponent(workspace)}/projects?pagelen=${PAGE}&sort=name`
  );
  if (!listed.ok) return listed;
  const projects: BrowseProject[] = [];
  for (const project of values(listed.body)) {
    const key = str(project.key);
    if (key) projects.push({ key, name: str(project.name) || key });
  }
  return { ok: true, projects };
}

/**
 * Repositories: of one workspace (and one of its projects), or across
 * every workspace the person belongs to, filtered by a name fragment.
 */
export async function listRepositories(
  auth: BitbucketAuth,
  filter: { workspace?: string; project?: string; query?: string }
): Promise<{ ok: true; repos: RepoChoice[] } | { ok: false; error: string }> {
  let slugs: string[];
  if (filter.workspace) slugs = [filter.workspace];
  else {
    const workspaces = await listWorkspaces(auth);
    if (!workspaces.ok) return workspaces;
    slugs = workspaces.workspaces.map((workspace) => workspace.slug);
  }
  const clauses: string[] = [];
  if (filter.query) clauses.push(`name ~ "${filter.query.replace(/"/g, '')}"`);
  if (filter.project) clauses.push(`project.key = "${filter.project.replace(/"/g, '')}"`);
  const repos: RepoChoice[] = [];
  for (const slug of slugs) {
    const parts = [`pagelen=${PAGE}`, 'sort=-updated_on'];
    if (clauses.length) parts.push(`q=${encodeURIComponent(clauses.join(' AND '))}`);
    const listed = await bbJson(
      auth,
      ['repository'],
      `/repositories/${encodeURIComponent(slug)}?${parts.join('&')}`
    );
    if (!listed.ok) {
      if (filter.workspace) return listed;
      continue;
    }
    for (const repo of values(listed.body)) {
      const fullName = str(repo.full_name);
      if (!fullName) continue;
      repos.push({
        fullName,
        name: str(repo.name) || fullName.split('/').pop() || fullName,
        projectKey: str(rec(repo.project).key) || null,
        mainBranch: str(rec(repo.mainbranch).name) || null,
        updatedOn: str(repo.updated_on) || null,
      });
    }
  }
  repos.sort((a, b) => (b.updatedOn ?? '').localeCompare(a.updatedOn ?? ''));
  return { ok: true, repos };
}

/**
 * A brand-new, empty repository under a workspace's project — for the
 * new-project form's "Create new repository" tab. The slug is derived
 * from the name (Bitbucket's URL takes the slug, not the display name);
 * the repository starts private with nothing in it, so the caller still
 * gets no branch back — the first chat's clone is what puts anything on it.
 */
export async function createRepository(
  auth: BitbucketAuth,
  input: { workspace: string; project: string; name: string }
): Promise<{ ok: true; repo: RepoChoice } | { ok: false; error: string }> {
  const workspace = input.workspace.trim();
  const project = input.project.trim();
  const name = input.name.trim();
  if (!workspace) return { ok: false, error: 'Pick a workspace.' };
  if (!project) return { ok: false, error: 'Pick a project.' };
  if (!name) return { ok: false, error: 'Give the repository a name.' };
  const slug = repoSlugFromName(name);
  if (!slug) {
    return { ok: false, error: 'That name has no characters a repository slug can use.' };
  }
  const created = await bbJson(
    auth,
    ['repository:admin'],
    `/repositories/${encodeURIComponent(workspace)}/${encodeURIComponent(slug)}`,
    { method: 'POST', json: { scm: 'git', name, project: { key: project }, is_private: true } }
  );
  if (!created.ok) return created;
  const repo = created.body;
  return {
    ok: true,
    repo: {
      fullName: str(repo.full_name) || `${workspace}/${slug}`,
      name: str(repo.name) || name,
      projectKey: str(rec(repo.project).key) || project,
      mainBranch: str(rec(repo.mainbranch).name) || null,
      updatedOn: str(repo.updated_on) || null,
    },
  };
}

export interface SourceEntry {
  path: string;
  kind: 'file' | 'dir';
  sizeBytes: number | null;
}

const SOURCE_PAGES = 5;

/** The branch to read: the project's, else the repository's main branch. */
async function refOf(auth: BitbucketAuth, base: string, branch: string): Promise<string | null> {
  if (branch) return branch;
  const repo = await bbJson(auth, ['repository'], base);
  if (!repo.ok) return null;
  return str(rec(repo.body.mainbranch).name) || null;
}

/**
 * One directory of the repository as Bitbucket has it on the branch —
 * the tree a project page shows before anything is cloned. Directories
 * first, then files with sizes; a few pages at most.
 */
export async function listSource(
  auth: BitbucketAuth,
  fullName: string,
  branch: string,
  path: string
): Promise<{ ok: true; entries: SourceEntry[]; ref: string } | { ok: false; error: string }> {
  const [workspace, slug] = fullName.split('/');
  if (!workspace || !slug) return { ok: false, error: 'The repository name is not usable.' };
  const base = `/repositories/${encodeURIComponent(workspace)}/${encodeURIComponent(slug)}`;
  const ref = await refOf(auth, base, branch);
  if (!ref) return { ok: false, error: 'The repository’s branch could not be read.' };
  const clean = path.replace(/^\/+|\/+$/g, '');
  const dir = clean
    ? clean
        .split('/')
        .map((part) => encodeURIComponent(part))
        .join('/') + '/'
    : '';
  const entries: SourceEntry[] = [];
  let next: string | null = `${base}/src/${encodeURIComponent(ref)}/${dir}?pagelen=100`;
  for (let page = 0; next && page < SOURCE_PAGES; page += 1) {
    const listed = await bbJson(auth, ['repository'], next);
    if (!listed.ok) return listed;
    for (const entry of values(listed.body)) {
      const entryPath = str(entry.path);
      const type = str(entry.type);
      if (!entryPath) continue;
      if (type === 'commit_directory')
        entries.push({ path: entryPath, kind: 'dir', sizeBytes: null });
      else if (type === 'commit_file') {
        entries.push({
          path: entryPath,
          kind: 'file',
          sizeBytes: typeof entry.size === 'number' ? entry.size : null,
        });
      }
    }
    const nextUrl = str(listed.body.next);
    // Bitbucket hands back an absolute URL; the client takes the path.
    next = nextUrl ? nextUrl.replace(/^https?:\/\/[^/]+\/2\.0/, '') : null;
  }
  entries.sort((a, b) => {
    const rank = (kind: string) => (kind === 'dir' ? 0 : 1);
    return rank(a.kind) - rank(b.kind) || a.path.localeCompare(b.path);
  });
  return { ok: true, entries, ref };
}

/**
 * The repository's README on a branch (the project's, or the
 * repository's main branch), as Markdown text — or null when there is
 * none, the branch is unknown, or Bitbucket cannot be read. Best effort:
 * a project page never fails for want of a README.
 */
export async function readReadme(
  auth: BitbucketAuth,
  fullName: string,
  branch: string
): Promise<{ path: string; text: string } | null> {
  const [workspace, slug] = fullName.split('/');
  if (!workspace || !slug) return null;
  const base = `/repositories/${encodeURIComponent(workspace)}/${encodeURIComponent(slug)}`;
  const ref = await refOf(auth, base, branch);
  if (!ref) return null;
  for (const name of README_NAMES) {
    const file = await bbRawText(
      auth,
      ['repository'],
      `${base}/src/${encodeURIComponent(ref)}/${encodeURIComponent(name)}`
    );
    if (file.ok && file.text.trim()) {
      return { path: name, text: file.text.slice(0, README_MAX_CHARS) };
    }
  }
  return null;
}

/** The largest file the code pane reads from Bitbucket before a clone, in characters. */
const SOURCE_FILE_MAX_CHARS = 200_000;

/**
 * One file of the repository as Bitbucket has it on the branch — what
 * the code pane shows before any chat has cloned, read-only. A file that
 * is not text answers `binary`; a long one is cut and says so.
 */
export async function readSourceFile(
  auth: BitbucketAuth,
  fullName: string,
  branch: string,
  path: string
): Promise<
  | { ok: true; text: string; ref: string; truncated: boolean; binary: boolean }
  | { ok: false; error: string }
> {
  const [workspace, slug] = fullName.split('/');
  if (!workspace || !slug) return { ok: false, error: 'The repository name is not usable.' };
  const base = `/repositories/${encodeURIComponent(workspace)}/${encodeURIComponent(slug)}`;
  const ref = await refOf(auth, base, branch);
  if (!ref) return { ok: false, error: 'The repository’s branch could not be read.' };
  const encoded = path
    .split('/')
    .map((part) => encodeURIComponent(part))
    .join('/');
  const file = await bbRawText(
    auth,
    ['repository'],
    `${base}/src/${encodeURIComponent(ref)}/${encoded}`
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
