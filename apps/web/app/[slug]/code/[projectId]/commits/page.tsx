import { notFound, redirect } from 'next/navigation';
import { getDatabase } from '@renkei/db';
import { tenantForSlug } from '@/lib/tenant-slug';
import { getSessionFromCookies } from '@/lib/session';
import { signInUrl } from '@/lib/sign-in-url';
import { resolveResourceAccess } from '@/lib/chat/access';
import { getProjectRow } from '@/lib/chat/projects';
import CommitsPage from '../../_components/commits-page';

/**
 * A code project's recent commit history on its own branch, on a page
 * of its own — works for either host, through lib/code/repo-host.ts.
 */
export default async function CodeProjectCommitsPage({
  params,
}: {
  params: Promise<{ slug: string; projectId: string }>;
}) {
  const { slug, projectId } = await params;
  const tenant = await tenantForSlug(slug);
  if (!tenant) notFound();
  const session = await getSessionFromCookies(tenant.id);
  if (!session) redirect(signInUrl(tenant.id, `/${slug}/code/${projectId}/commits`));
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
  return (
    <CommitsPage
      slug={slug}
      tenantId={tenant.id}
      projectId={projectId}
      projectName={project.name}
      repoFullName={project.repo.fullName}
    />
  );
}
