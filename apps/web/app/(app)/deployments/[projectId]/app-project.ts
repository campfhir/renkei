import { cache } from 'react';
import { notFound, redirect } from 'next/navigation';
import { ATLASSIAN_BITBUCKET, GITHUB } from '@renkei/provider-grants';
import { resolveResourceAccess } from '@/lib/chat/access';
import { getProjectRow } from '@/lib/chat/projects';
import { getSessionFromCookies } from '@/lib/session';
import { signInUrl } from '@/lib/sign-in-url';

export interface AppProject {
  id: string;
  name: string;
  repo: string;
  /** The project's branch; empty for the repository's default. */
  branch: string;
  host: 'bitbucket' | 'github';
  canEdit: boolean;
}

/**
 * The code project an app page under Deployments is about, for the person
 * asking: signed out goes to sign-in (back to `path`), a project they
 * cannot open — or one that is not a code project on Bitbucket or GitHub —
 * is not found. Once per request, shared by the layout and its pages.
 */
export const appProject = cache(async (projectId: string, path: string): Promise<AppProject> => {
  const session = await getSessionFromCookies();
  if (!session) redirect(signInUrl(path));
  const access = await resolveResourceAccess(session.subject, 'chat_project', projectId);
  if (!access) notFound();
  const project = await getProjectRow(projectId);
  if (!project || project.kind !== 'code' || !project.repo) notFound();
  const host =
    project.repo.provider === GITHUB
      ? 'github'
      : project.repo.provider === ATLASSIAN_BITBUCKET
        ? 'bitbucket'
        : null;
  if (!host) notFound();
  return {
    id: project.id,
    name: project.name,
    repo: project.repo.fullName,
    branch: project.repo.branch,
    host,
    canEdit: access.role !== 'viewer',
  };
});
