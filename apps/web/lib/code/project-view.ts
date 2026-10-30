/**
 * A code project page's data: everything a chat project's page shows
 * (lib/chat/project-view.ts), plus the repository's checkout as the
 * worker sees it right now and the names of the project's variables.
 *
 * In three pieces, because they come from three places at three speeds.
 * `loadCodeProjectCore` is the database alone — the project, its chats,
 * its spend — and is what the page paints first. `loadCodeCheckoutState`
 * (the sandbox worker: the clone's row), `loadCodeEnvironment` (the
 * sandbox worker again: the variables' names) and `loadCodeReadme` (the
 * repository's git host) each cross the network, so the page streams
 * each of them in behind its own Suspense boundary rather than holding
 * the whole page for the slowest. `loadCodeProjectView` joins them all
 * for the JSON route that polls a clone.
 */

import type { ProjectAccess } from '@/lib/chat/access';
import { loadProjectView, type ProjectView } from '@/lib/chat/project-view';
import { getProjectRow, type ProjectRow } from '@/lib/chat/projects';
import { sandboxWorkspacesEnabled } from '@renkei/sandbox-client';
import { getPublicBaseUrl, getWorkspaceLimitBytes } from '@renkei/settings';
import { WORKSPACE_DEFAULT_MAX_BYTES } from '@renkei/connector-sandbox';
import { GITHUB } from '@renkei/provider-grants';
import { bitbucketAuthOf, readReadme as readBitbucketReadme } from './bitbucket-browse';
import { githubAuthOf, readReadme as readGitHubReadme } from './github-browse';
import { projectEnv, projectWorkspace } from './projects';
import { codeProjectTarget } from './scope';
import { latestSizeRequest, type SizeRequestView } from './size-requests';
import { loadCodeProjectUsage, type CodeProjectUsage } from './usage';

export interface CodeCheckoutState {
  workspace: {
    id: string;
    status: 'cloning' | 'ready' | 'failed';
    error: string | null;
    branch: string;
    sizeBytes: number;
    expiresAt: string;
  } | null;
  /** What this project's checkout may grow to: the org's limit, or a larger approved one. */
  sizeLimitBytes: number;
  /** The project's newest request for a larger checkout, whatever its state. */
  sizeRequest: SizeRequestView | null;
}

export interface CodeEnvVariableView {
  name: string;
  updatedAt: string;
  lastUsedAt: string | null;
}

export interface CodeProjectView extends ProjectView {
  code: CodeCheckoutState & {
    repoFullName: string;
    /** ATLASSIAN_BITBUCKET or GITHUB (@renkei/provider-grants) — which host the repository lives on. */
    repoProvider: string;
    branch: string;
    env: CodeEnvVariableView[];
    /** The deployment runs code workspaces at all. */
    enabled: boolean;
    /** The repository's README on the project's branch, as Markdown, read from its git host. */
    readme: { path: string; text: string } | null;
    /** Token spend: the project's total and each of its chats' own (usage.ts). */
    usage: CodeProjectUsage;
  };
}

/** The page's first paint: the project from the database, nothing over the network. */
export interface CodeProjectCore {
  view: ProjectView;
  project: ProjectRow & { repo: NonNullable<ProjectRow['repo']> };
  repoFullName: string;
  repoProvider: string;
  branch: string;
  enabled: boolean;
  usage: CodeProjectUsage;
}

export async function loadCodeProjectCore(
  viewerSubject: string,
  projectId: string,
  access: ProjectAccess
): Promise<CodeProjectCore | null> {
  const project = await getProjectRow(projectId);
  if (!project || project.kind !== 'code' || !project.repo) return null;
  const [view, usage, enabled] = await Promise.all([
    loadProjectView(viewerSubject, projectId, access),
    loadCodeProjectUsage(projectId),
    sandboxWorkspacesEnabled(),
  ]);
  if (!view) return null;
  return {
    view,
    project: { ...project, repo: project.repo },
    repoFullName: project.repo.fullName,
    repoProvider: project.repo.provider,
    branch: project.repo.branch,
    enabled,
    usage,
  };
}

/** The clone as the sandbox worker has it, with the project's size limit and its newest size request. */
export async function loadCodeCheckoutState(project: ProjectRow): Promise<CodeCheckoutState> {
  const [workspace, limit, sizeRequest] = await Promise.all([
    projectWorkspace(project),
    getWorkspaceLimitBytes(codeProjectTarget(project.id).subject),
    latestSizeRequest(project.id),
  ]);
  return {
    workspace: workspace
      ? {
          id: workspace.id,
          status: workspace.status,
          error: workspace.error,
          branch: workspace.branch,
          sizeBytes: workspace.sizeBytes,
          expiresAt: workspace.expiresAt,
        }
      : null,
    sizeLimitBytes: limit.ok ? limit.val : WORKSPACE_DEFAULT_MAX_BYTES,
    sizeRequest,
  };
}

/** The names of the project's variables, from the sandbox worker. Never their values. */
export async function loadCodeEnvironment(project: ProjectRow): Promise<CodeEnvVariableView[]> {
  const env = await projectEnv(project);
  return env.map((variable) => ({
    name: variable.name,
    updatedAt: variable.updatedAt,
    lastUsedAt: variable.lastUsedAt,
  }));
}

/** The repository's README on the project's branch, from its git host, with the viewer's own access. */
export async function loadCodeReadme(
  viewerSubject: string,
  project: ProjectRow
): Promise<{ path: string; text: string } | null> {
  if (!project.repo) return null;
  const origin = getPublicBaseUrl() ?? '';
  return project.repo.provider === GITHUB
    ? readGitHubReadme(
        githubAuthOf({ subject: viewerSubject, origin }),
        project.repo.fullName,
        project.repo.branch
      )
    : readBitbucketReadme(
        bitbucketAuthOf({ subject: viewerSubject, origin }),
        project.repo.fullName,
        project.repo.branch
      );
}

export async function loadCodeProjectView(
  viewerSubject: string,
  projectId: string,
  access: ProjectAccess
): Promise<CodeProjectView | null> {
  const core = await loadCodeProjectCore(viewerSubject, projectId, access);
  if (!core) return null;
  const [checkout, env, readme] = await Promise.all([
    loadCodeCheckoutState(core.project),
    loadCodeEnvironment(core.project),
    loadCodeReadme(viewerSubject, core.project),
  ]);
  return {
    ...core.view,
    code: {
      ...checkout,
      repoFullName: core.repoFullName,
      repoProvider: core.repoProvider,
      branch: core.branch,
      env,
      enabled: core.enabled,
      readme,
      usage: core.usage,
    },
  };
}
