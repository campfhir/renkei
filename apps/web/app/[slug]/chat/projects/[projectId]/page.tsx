import { notFound, redirect } from 'next/navigation';
import { getDatabase } from '@renkei/db';
import { tenantForSlug } from '@/lib/tenant-slug';
import { getSessionFromCookies } from '@/lib/session';
import { signInUrl } from '@/lib/sign-in-url';
import { resolveResourceAccess } from '@/lib/chat/access';
import { loadProjectView } from '@/lib/chat/project-view';
import ProjectView from '../../_components/project-view';

/**
 * One project: instructions, files, memory, toolset and the chats inside
 * it. Editors change it; viewers read it and start their own chats in it.
 */
export default async function ProjectPage({
  params,
}: {
  params: Promise<{ slug: string; projectId: string }>;
}) {
  const { slug, projectId } = await params;
  const tenant = await tenantForSlug(slug);
  if (!tenant) notFound();
  const session = await getSessionFromCookies(tenant.id);
  if (!session) redirect(signInUrl(tenant.id, `/${slug}/chat/projects/${projectId}`));
  const dbResult = getDatabase();
  if (!dbResult.ok) notFound();
  const db = dbResult.val;
  const access = await resolveResourceAccess(
    db,
    tenant.id,
    session.subject,
    'chat_project',
    projectId
  );
  if (!access) notFound();
  const view = await loadProjectView(db, tenant.id, session.subject, projectId, access);
  if (!view) notFound();
  return <ProjectView key={projectId} slug={slug} tenantId={tenant.id} initial={view} />;
}
