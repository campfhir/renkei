import { notFound, redirect } from 'next/navigation';
import { getDatabase } from '@renkei/db';
import { getSessionFromCookies } from '@/lib/session';
import { signInUrl } from '@/lib/sign-in-url';
import { resolveResourceAccess } from '@/lib/chat/access';
import { getProjectRow } from '@/lib/chat/projects';
import PullsPage from '../../_components/pulls-page';

/**
 * A code project's open pull requests, on a page of its own so the
 * project page stays a summary — works for either host, through
 * lib/code/repo-host.ts.
 */
export default async function CodeProjectPullsPage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;
  const session = await getSessionFromCookies();
  if (!session) redirect(signInUrl(`/code/${projectId}/pulls`));
  const dbResult = getDatabase();
  if (!dbResult.ok) notFound();
  const db = dbResult.val;
  const access = await resolveResourceAccess(
    db,
    session.subject,
    'chat_project',
    projectId
  );
  if (!access) notFound();
  const project = await getProjectRow(db, projectId);
  if (!project || project.kind !== 'code' || !project.repo) notFound();
  return (
    <PullsPage
      projectId={projectId}
      projectName={project.name}
      repoFullName={project.repo.fullName}
    />
  );
}
