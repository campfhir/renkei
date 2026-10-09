import { notFound, redirect } from 'next/navigation';
import { getDatabase } from '@renkei/db';
import { sandboxServicesEnabled } from '@renkei/sandbox-client';
import { getSessionFromCookies } from '@/lib/session';
import { signInUrl } from '@/lib/sign-in-url';
import { resolveResourceAccess } from '@/lib/chat/access';
import { getProjectRow } from '@/lib/chat/projects';
import ServicesPage from '../../_components/services-page';

/**
 * A code project's Services: the containers running beside its checkout
 * — a database, a cache, a broker for the project's tests — with their
 * address, what they set for every command, their logs, and a way to
 * start one or stop one; on a page of its own so the project page stays
 * a summary. Editors start and stop; viewers read.
 */
export default async function CodeProjectServicesPage({
  params,
}: {
  params: Promise<{ slug: string; projectId: string }>;
}) {
  const { slug, projectId } = await params;
  const session = await getSessionFromCookies();
  if (!session) redirect(signInUrl(`/code/${projectId}/services`));
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
    <ServicesPage
      slug={slug}
      projectId={projectId}
      projectName={project.name}
      repoFullName={project.repo.fullName}
      enabled={await sandboxServicesEnabled()}
      canEdit={access.role !== 'viewer'}
    />
  );
}
