import { notFound, redirect } from 'next/navigation';
import { getDatabase } from '@renkei/db';
import { ATLASSIAN_BITBUCKET } from '@renkei/provider-grants';
import { tenantForSlug } from '@/lib/tenant-slug';
import { getSessionFromCookies } from '@/lib/session';
import { signInUrl } from '@/lib/sign-in-url';
import { resolveResourceAccess } from '@/lib/chat/access';
import { getProjectRow } from '@/lib/chat/projects';
import PipelinesPage from '../../_components/pipelines-page';

/**
 * A code project's Pipelines: its repository's recent runs, the switch
 * and the pipeline file, and the variables the runs get — on a page of
 * its own so the project page stays a summary. Editors change the setup;
 * viewers read it. Bitbucket only, for now: a GitHub Actions variant
 * would branch here on the repository's provider.
 */
export default async function CodeProjectPipelinesPage({
  params,
}: {
  params: Promise<{ slug: string; projectId: string }>;
}) {
  const { slug, projectId } = await params;
  const tenant = await tenantForSlug(slug);
  if (!tenant) notFound();
  const session = await getSessionFromCookies(tenant.id);
  if (!session) redirect(signInUrl(tenant.id, `/${slug}/code/${projectId}/pipelines`));
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
  if (project.repo.provider !== ATLASSIAN_BITBUCKET) notFound();
  return (
    <PipelinesPage
      slug={slug}
      tenantId={tenant.id}
      projectId={projectId}
      projectName={project.name}
      repoFullName={project.repo.fullName}
      branch={project.repo.branch}
      canEdit={access.role !== 'viewer'}
    />
  );
}
