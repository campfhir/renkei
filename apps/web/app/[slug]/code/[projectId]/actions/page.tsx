import { notFound, redirect } from 'next/navigation';
import { getDatabase } from '@renkei/db';
import { GITHUB } from '@renkei/provider-grants';
import { tenantForSlug } from '@/lib/tenant-slug';
import { getSessionFromCookies } from '@/lib/session';
import { signInUrl } from '@/lib/sign-in-url';
import { resolveResourceAccess } from '@/lib/chat/access';
import { getProjectRow } from '@/lib/chat/projects';
import ActionsPage from '../../_components/actions-page';

/**
 * A GitHub code project's recent Actions runs, on a page of its own —
 * GitHub only, the way pipelines/page.tsx (its Bitbucket counterpart)
 * is Bitbucket only.
 */
export default async function CodeProjectActionsPage({
  params,
}: {
  params: Promise<{ slug: string; projectId: string }>;
}) {
  const { slug, projectId } = await params;
  const tenant = await tenantForSlug(slug);
  if (!tenant) notFound();
  const session = await getSessionFromCookies(tenant.id);
  if (!session) redirect(signInUrl(tenant.id, `/${slug}/code/${projectId}/actions`));
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
  const project = await getProjectRow(db, tenant.id, projectId);
  if (!project || project.kind !== 'code' || !project.repo) notFound();
  if (project.repo.provider !== GITHUB) notFound();
  return (
    <ActionsPage
      slug={slug}
      tenantId={tenant.id}
      projectId={projectId}
      projectName={project.name}
      repoFullName={project.repo.fullName}
    />
  );
}
