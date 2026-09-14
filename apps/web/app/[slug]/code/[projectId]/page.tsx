import { notFound, redirect } from 'next/navigation';
import { getDatabase } from '@renkei/db';
import { tenantForSlug } from '@/lib/tenant-slug';
import { getSessionFromCookies } from '@/lib/session';
import { signInUrl } from '@/lib/sign-in-url';
import { resolveResourceAccess } from '@/lib/chat/access';
import { loadCodeProjectView } from '@/lib/code/project-view';
import ProjectView from '../../chat/_components/project-view';
import CodeSections from '../_components/code-sections';

/**
 * One code project: its repository's checkout and its environment on
 * top, then everything a chat project's page has — instructions, files,
 * memory, toolset, the chats inside it, sharing. Editors change it;
 * viewers read it and start their own chats in it.
 */
export default async function CodeProjectPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string; projectId: string }>;
  searchParams: Promise<{ envProblems?: string }>;
}) {
  const { slug, projectId } = await params;
  const { envProblems } = await searchParams;
  const tenant = await tenantForSlug(slug);
  if (!tenant) notFound();
  const session = await getSessionFromCookies(tenant.id);
  if (!session) redirect(signInUrl(tenant.id, `/${slug}/code/${projectId}`));
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
  const view = await loadCodeProjectView(db, tenant.id, session.subject, projectId, access);
  if (!view) notFound();
  return (
    <ProjectView
      key={projectId}
      slug={slug}
      tenantId={tenant.id}
      initial={view}
      variant="code"
      before={
        <CodeSections
          tenantId={tenant.id}
          projectId={projectId}
          code={view.code}
          canEdit={view.role !== 'viewer'}
          envProblems={envProblems ? envProblems.split('\n').filter(Boolean) : []}
        />
      }
    />
  );
}
