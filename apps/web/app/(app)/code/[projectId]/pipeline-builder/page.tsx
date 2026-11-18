import { notFound, redirect } from 'next/navigation';
import { ATLASSIAN_BITBUCKET, GITHUB } from '@renkei/provider-grants';
import { getSessionFromCookies } from '@/lib/session';
import { signInUrl } from '@/lib/sign-in-url';
import { resolveResourceAccess } from '@/lib/chat/access';
import { getProjectRow } from '@/lib/chat/projects';
import PipelineBuilder from '../../_components/pipeline-builder';

/**
 * A code project's pipeline, built from the organization's blocks: the
 * pull-request checks and each environment's branch and steps, the file
 * it writes for the repository's host, the checks before it runs, and a
 * pull request that carries the file. Bitbucket and GitHub alike; editors
 * change it, viewers read it.
 */
export default async function CodeProjectPipelineBuilderPage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;
  const session = await getSessionFromCookies();
  if (!session) redirect(signInUrl(`/code/${projectId}/pipeline-builder`));
  const access = await resolveResourceAccess(session.subject, 'chat_project', projectId);
  if (!access) notFound();
  const project = await getProjectRow(projectId);
  if (!project || project.kind !== 'code' || !project.repo) notFound();
  if (project.repo.provider !== GITHUB && project.repo.provider !== ATLASSIAN_BITBUCKET) notFound();
  return (
    <PipelineBuilder
      projectId={projectId}
      projectName={project.name}
      repoFullName={project.repo.fullName}
      host={project.repo.provider === GITHUB ? 'github' : 'bitbucket'}
    />
  );
}
