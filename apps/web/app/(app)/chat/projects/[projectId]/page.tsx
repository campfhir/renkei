import { notFound, redirect } from 'next/navigation';
import { getSessionFromCookies } from '@/lib/session';
import { signInUrl } from '@/lib/sign-in-url';
import { resolveProjectAccess } from '@/lib/chat/access';
import { loadProjectView } from '@/lib/chat/project-view';
import ProjectView from '../../_components/project-view';

/**
 * One project: instructions, files, memory, toolset and the chats inside
 * it. Editors change it; viewers read it and start their own chats in it.
 */
export default async function ProjectPage({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  const session = await getSessionFromCookies();
  if (!session) redirect(signInUrl(`/chat/projects/${projectId}`));
  const access = await resolveProjectAccess(session.subject, projectId);
  if (!access) notFound();
  const view = await loadProjectView(session.subject, projectId, access);
  if (!view) notFound();
  return <ProjectView key={projectId} initial={view} />;
}
