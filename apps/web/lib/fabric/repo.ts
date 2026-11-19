/**
 * Fabric changes as pull requests: the files of one or more Fabric items
 * (@renkei/connector-fabric git-format.ts) committed to a fresh branch of a
 * code project's repository, and a pull request opened against the branch
 * its first environment deploys from — so a change reaches Fabric only when
 * someone merges it and the project's pipeline runs its "Fabric: deploy
 * items" block (packages/db migration 189).
 *
 * Every call is the person's own: their access to the code project (an
 * editor's, in an organization that is not read-only) and their grant on
 * the repository's host. The pipeline builder's pull request
 * (lib/ci/pipeline-builder.ts) is the model; this one carries several files
 * and never reuses a branch.
 */

import { getDataStore } from '@renkei/db';
import { readPipelineSpec, type Host } from '@renkei/ci-blocks';
import { getOrgSettings } from '@renkei/settings';
import { isRecord } from '@renkei/guards';
import { trimChar, type RepoFile } from '@renkei/connector-fabric';
import { resolveResourceAccess } from '@/lib/chat/access';
import { getProjectRow } from '@/lib/chat/projects';
import { loadChatSidebar } from '@/lib/chat/sidebar';
import { bitbucketAuthOf } from '@/lib/code/bitbucket-browse';
import { repoBase } from '@/lib/code/bitbucket-pipelines';
import { githubAuthOf } from '@/lib/code/github-browse';
import { ownerRepoOf } from '@/lib/code/github-actions';
import { hostOf, type CodeRepoProject } from '@/lib/ci/pipeline-builder';
import { bbJson, describeBitbucketFailure } from '@/lib/mcp-tools/bitbucket/client';
import { ghJson, rec, str } from '@/lib/mcp-tools/github/client';

export interface Caller {
  subject: string;
  origin: string;
}

export interface RepoProject {
  project: CodeRepoProject;
  host: Host;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A code project the person may change, by id or exact name; a string says
 * why not. Only a Bitbucket or GitHub repository has a pipeline to deploy.
 */
export async function resolveRepoProject(
  subject: string,
  ref: string
): Promise<RepoProject | string> {
  let projectId = ref.trim();
  if (!UUID.test(projectId)) {
    const sidebar = await loadChatSidebar(subject).catch(() => null);
    const wanted = projectId.toLowerCase();
    const named = (sidebar?.code.projects ?? []).filter(
      (project) => project.name.toLowerCase() === wanted
    );
    if (named.length === 0) return `No code project named "${ref}" that you can open.`;
    if (named.length > 1) {
      return `More than one code project is named "${ref}"; say which by id: ${named.map((p) => p.id).join(', ')}`;
    }
    projectId = named[0].id;
  }
  const access = await resolveResourceAccess(subject, 'chat_project', projectId);
  const project = access ? await getProjectRow(projectId) : null;
  if (!access || !project || project.kind !== 'code' || !project.repo) {
    return `No code project ${ref} that you can open.`;
  }
  const host = hostOf(project.repo.provider);
  if (!host) return 'Only a Bitbucket or GitHub repository has a pipeline to deploy Fabric items.';
  if (access.role === 'viewer')
    return `You can only view "${project.name}"; an editor proposes changes to it.`;
  const settings = await getOrgSettings();
  if (settings.ok && settings.val.readOnly) return 'The organization is in read-only mode.';
  return { project: { ...project, repo: project.repo }, host };
}

/** The environments of the project's pipeline, as saved in the pipeline builder; none before one is. */
export async function pipelineEnvironments(
  project: CodeRepoProject
): Promise<{ name: string; branch: string }[]> {
  const saved = await getDataStore().ciPipelines.get(project.id);
  const spec = saved ? readPipelineSpec(saved.spec) : null;
  return spec?.ok ? spec.value.environments.map((e) => ({ name: e.name, branch: e.branch })) : [];
}

/** The branch a change is proposed against: the one asked for, the first environment's, or the project's. */
export async function proposalBase(project: CodeRepoProject, asked?: string): Promise<string> {
  if (asked?.trim()) return asked.trim();
  const [first] = await pipelineEnvironments(project);
  return first?.branch ?? project.repo.branch;
}

/** A branch name for one proposal: renkei/fabric/<what>-<minute>. */
export function proposalBranch(what: string, now: Date): string {
  const slug = trimChar(
    trimChar(what.toLowerCase().replace(/[^a-z0-9]+/g, '-'), '-').slice(0, 40),
    '-'
  );
  const stamp = now.toISOString().slice(0, 16).replace(/[-:T]/g, '');
  return `renkei/fabric/${slug || 'change'}-${stamp}`;
}

/** One file's text on a branch; null when it is not there. */
export async function readRepoFile(
  caller: Caller,
  { project, host }: RepoProject,
  branch: string,
  path: string
): Promise<string | null> {
  const encodedPath = path.split('/').map(encodeURIComponent).join('/');
  if (host === 'github') {
    const target = ownerRepoOf(project.repo.fullName);
    if (!target) return null;
    const found = await ghJson(
      githubAuthOf(caller),
      ['repository'],
      `/repos/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.repo)}/contents/${encodedPath}?ref=${encodeURIComponent(branch)}`
    );
    if (!found.ok) return null;
    const encoded = str(rec(found.body).content).replace(/\s+/g, '');
    return encoded ? Buffer.from(encoded, 'base64').toString('utf8') : null;
  }
  const base = repoBase(project.repo.fullName);
  if (!base) return null;
  const auth = bitbucketAuthOf(caller);
  const response = await auth.fetch(
    ['repository'],
    `${base}/src/${encodeURIComponent(branch)}/${encodedPath}`,
    { method: 'GET' }
  );
  return response.ok ? await response.text() : null;
}

/** The logical id an item's `.platform` on the branch already carries, so a replacement stays the same item. */
export async function existingLogicalId(
  caller: Caller,
  repo: RepoProject,
  branch: string,
  platformPath: string
): Promise<string | null> {
  const text = await readRepoFile(caller, repo, branch, platformPath);
  if (!text) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    const config = isRecord(parsed) && isRecord(parsed.config) ? parsed.config : {};
    return typeof config.logicalId === 'string' && config.logicalId ? config.logicalId : null;
  } catch {
    return null;
  }
}

export interface Proposal {
  files: RepoFile[];
  base: string;
  branch: string;
  message: string;
  title: string;
  description: string;
}

export type Proposed = { ok: true; url: string; branch: string } | { ok: false; error: string };

async function proposeOnBitbucket(
  caller: Caller,
  project: CodeRepoProject,
  proposal: Proposal
): Promise<Proposed> {
  const auth = bitbucketAuthOf(caller);
  const base = repoBase(project.repo.fullName);
  if (!base) return { ok: false, error: 'The repository name is not usable.' };
  const head = await bbJson(
    auth,
    ['repository'],
    `${base}/refs/branches/${encodeURIComponent(proposal.base)}`
  );
  const sha = head.ok ? str(rec(rec(head.body).target).hash) : '';
  if (!sha)
    return {
      ok: false,
      error: `Bitbucket has no branch ${proposal.base} in ${project.repo.fullName}.`,
    };
  const form = new URLSearchParams();
  for (const file of proposal.files) form.set(file.path, file.text);
  form.set('message', proposal.message);
  form.set('branch', proposal.branch);
  form.set('parents', sha);
  const committed = await auth.fetch(['repository:write'], `${base}/src`, { method: 'POST', form });
  if (!committed.ok) {
    return {
      ok: false,
      error: `Bitbucket refused the commit: ${await describeBitbucketFailure(committed)}`,
    };
  }
  const pr = await auth.fetch(['pullrequest:write'], `${base}/pullrequests`, {
    method: 'POST',
    json: {
      title: proposal.title,
      description: proposal.description,
      source: { branch: { name: proposal.branch } },
      destination: { branch: { name: proposal.base } },
      close_source_branch: true,
    },
  });
  if (!pr.ok) {
    return {
      ok: false,
      error: `The files are on ${proposal.branch}, but Bitbucket refused the pull request: ${await describeBitbucketFailure(pr)}`,
    };
  }
  const body: unknown = await pr.json().catch(() => null);
  const [workspace, slug] = project.repo.fullName.split('/');
  return {
    ok: true,
    branch: proposal.branch,
    url:
      str(rec(rec(rec(body).links).html).href) ||
      `https://bitbucket.org/${workspace}/${slug}/pull-requests/${str(rec(body).id)}`,
  };
}

async function proposeOnGithub(
  caller: Caller,
  project: CodeRepoProject,
  proposal: Proposal
): Promise<Proposed> {
  const auth = githubAuthOf(caller);
  const target = ownerRepoOf(project.repo.fullName);
  if (!target) return { ok: false, error: 'The repository name is not usable.' };
  const path = `/repos/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.repo)}`;
  const write = ['repository:write'];
  const head = await ghJson(
    auth,
    ['repository'],
    `${path}/git/ref/heads/${encodeURIComponent(proposal.base)}`
  );
  const baseSha = head.ok ? str(rec(rec(head.body).object).sha) : '';
  if (!baseSha)
    return {
      ok: false,
      error: `GitHub has no branch ${proposal.base} in ${project.repo.fullName}.`,
    };
  const baseCommit = await ghJson(auth, ['repository'], `${path}/git/commits/${baseSha}`);
  if (!baseCommit.ok) return baseCommit;
  // One commit for every file: a tree over the base's, a commit on it, a branch at it.
  const tree = await ghJson(auth, write, `${path}/git/trees`, {
    method: 'POST',
    json: {
      base_tree: str(rec(rec(baseCommit.body).tree).sha),
      tree: proposal.files.map((file) => ({
        path: file.path,
        mode: '100644',
        type: 'blob',
        content: file.text,
      })),
    },
  });
  if (!tree.ok) return { ok: false, error: `GitHub refused the files: ${tree.error}` };
  const commit = await ghJson(auth, write, `${path}/git/commits`, {
    method: 'POST',
    json: { message: proposal.message, tree: str(rec(tree.body).sha), parents: [baseSha] },
  });
  if (!commit.ok) return { ok: false, error: `GitHub refused the commit: ${commit.error}` };
  const ref = await ghJson(auth, write, `${path}/git/refs`, {
    method: 'POST',
    json: { ref: `refs/heads/${proposal.branch}`, sha: str(rec(commit.body).sha) },
  });
  if (!ref.ok)
    return { ok: false, error: `GitHub refused the branch ${proposal.branch}: ${ref.error}` };
  const pr = await ghJson(auth, ['pullrequest:write'], `${path}/pulls`, {
    method: 'POST',
    json: {
      title: proposal.title,
      body: proposal.description,
      head: proposal.branch,
      base: proposal.base,
    },
  });
  if (!pr.ok) {
    return {
      ok: false,
      error: `The files are on ${proposal.branch}, but GitHub refused the pull request: ${pr.error}`,
    };
  }
  return { ok: true, branch: proposal.branch, url: str(rec(pr.body).html_url) };
}

/** Commit the files to a new branch and open the pull request against `base`. */
export async function proposeFiles(
  caller: Caller,
  repo: RepoProject,
  proposal: Proposal
): Promise<Proposed> {
  if (proposal.files.length === 0) return { ok: false, error: 'There is nothing to commit.' };
  return repo.host === 'github'
    ? proposeOnGithub(caller, repo.project, proposal)
    : proposeOnBitbucket(caller, repo.project, proposal);
}
