/**
 * A code project page's data: everything a chat project's page shows
 * (lib/chat/project-view.ts), plus the repository's checkout as the
 * worker sees it right now and the names of the project's variables.
 */

import type { Kysely } from 'kysely';
import type { DB } from '@renkei/db';
import type { ResourceAccess } from '@/lib/chat/access';
import { loadProjectView, type ProjectView } from '@/lib/chat/project-view';
import { getProjectRow } from '@/lib/chat/projects';
import { sandboxWorkspacesEnabled } from '@renkei/sandbox-client';
import { getPublicBaseUrl } from '@renkei/settings';
import { GITHUB } from '@renkei/provider-grants';
import { bitbucketAuthOf, readReadme as readBitbucketReadme } from './bitbucket-browse';
import { githubAuthOf, readReadme as readGitHubReadme } from './github-browse';
import { projectEnv, projectWorkspace } from './projects';
import { loadCodeProjectUsage, type CodeProjectUsage } from './usage';

export interface CodeProjectView extends ProjectView {
  code: {
    repoFullName: string;
    /** ATLASSIAN_BITBUCKET or GITHUB (@renkei/provider-grants) — which host the repository lives on. */
    repoProvider: string;
    branch: string;
    workspace: {
      id: string;
      status: 'cloning' | 'ready' | 'failed';
      error: string | null;
      branch: string;
      sizeBytes: number;
      expiresAt: string;
    } | null;
    env: { name: string; updatedAt: string; lastUsedAt: string | null }[];
    /** The deployment runs code workspaces at all. */
    enabled: boolean;
    /** The repository's README on the project's branch, as Markdown, read from its git host. */
    readme: { path: string; text: string } | null;
    /** Token spend: the project's total and each of its chats' own (usage.ts). */
    usage: CodeProjectUsage;
  };
}

export async function loadCodeProjectView(
  db: Kysely<DB>,
  tenantId: string,
  viewerSubject: string,
  projectId: string,
  access: ResourceAccess
): Promise<CodeProjectView | null> {
  const project = await getProjectRow(db, tenantId, projectId);
  if (!project || project.kind !== 'code' || !project.repo) return null;
  const origin = getPublicBaseUrl() ?? '';
  const readme =
    project.repo.provider === GITHUB
      ? readGitHubReadme(
          githubAuthOf({ tenantId, subject: viewerSubject, origin }),
          project.repo.fullName,
          project.repo.branch
        )
      : readBitbucketReadme(
          bitbucketAuthOf({ tenantId, subject: viewerSubject, origin }),
          project.repo.fullName,
          project.repo.branch
        );
  const [view, workspace, env, readmeResult, usage] = await Promise.all([
    loadProjectView(db, tenantId, viewerSubject, projectId, access),
    projectWorkspace(project),
    projectEnv(project),
    readme,
    loadCodeProjectUsage(db, tenantId, projectId),
  ]);
  if (!view) return null;
  return {
    ...view,
    code: {
      repoFullName: project.repo.fullName,
      repoProvider: project.repo.provider,
      branch: project.repo.branch,
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
      env: env.map((variable) => ({
        name: variable.name,
        updatedAt: variable.updatedAt,
        lastUsedAt: variable.lastUsedAt,
      })),
      enabled: sandboxWorkspacesEnabled(),
      readme: readmeResult,
      usage,
    },
  };
}
