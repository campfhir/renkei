import { notFound, redirect } from 'next/navigation';
import { getDatabase } from '@renkei/db';
import { tenantForSlug } from '@/lib/tenant-slug';
import { getSessionFromCookies } from '@/lib/session';
import { signInUrl } from '@/lib/sign-in-url';
import { loadChatSidebar } from '@/lib/chat/sidebar';
import ProjectsIndex from '../_components/projects-index';

/**
 * Projects: mine, and the ones shared with me or published to the org.
 * `?new=1` opens the create dialog straight away (the sidebar's "+").
 */
export default async function ProjectsPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ new?: string }>;
}) {
  const { slug } = await params;
  const { new: openNew } = await searchParams;
  const tenant = await tenantForSlug(slug);
  if (!tenant) notFound();
  const session = await getSessionFromCookies(tenant.id);
  if (!session) redirect(signInUrl(tenant.id, `/${slug}/chat/projects`));
  const dbResult = getDatabase();
  if (!dbResult.ok) notFound();
  const sidebar = await loadChatSidebar(dbResult.val, tenant.id, session.subject);
  return (
    <ProjectsIndex
      slug={slug}
      tenantId={tenant.id}
      projects={sidebar.projects}
      openNew={openNew === '1'}
    />
  );
}
