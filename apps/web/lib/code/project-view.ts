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
import { bitbucketAuthOf, readReadme } from './bitbucket-browse';
import { projectEnv, projectWorkspace } from './projects';

export interface CodeProjectView extends ProjectView {
  code: {
    repoFullName: string;
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
    /** The repository's README on the project's branch, as Markdown, read from Bitbucket. */
    readme: { path: string; text: string } | null;
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
  const [view, workspace, env, readme] = await Promise.all([
    loadProjectView(db, tenantId, viewerSubject, projectId, access),
    projectWorkspace(project),
    projectEnv(project),
    readReadme(
      bitbucketAuthOf({ tenantId, subject: viewerSubject, origin: getPublicBaseUrl() ?? '' }),
      project.repo.fullName,
      project.repo.branch
    ),
  ]);
  if (!view) return null;
  return {
    ...view,
    code: {
      repoFullName: project.repo.fullName,
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
      readme,
    },
  };
}
