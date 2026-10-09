import { notFound, redirect } from 'next/navigation';
import { getDatabase } from '@renkei/db';
import { getSessionFromCookies } from '@/lib/session';
import { signInUrl } from '@/lib/sign-in-url';
import { loadChatSidebar } from '@/lib/chat/sidebar';
import ProjectsIndex from '../_components/projects-index';

/**
 * Projects: mine, and the ones shared with me or published to the org.
 * `?new=1` opens the create dialog straight away (the sidebar's "+").
 */
export default async function ProjectsPage({ searchParams }: {
  searchParams: Promise<{ new?: string }>;
}) {
  const { new: openNew } = await searchParams;
  const session = await getSessionFromCookies();
  if (!session) redirect(signInUrl(`/chat/projects`));
  const dbResult = getDatabase();
  if (!dbResult.ok) notFound();
  const sidebar = await loadChatSidebar(dbResult.val, session.subject);
  return (
    <ProjectsIndex
      projects={sidebar.projects}
      openNew={openNew === '1'}
    />
  );
}
