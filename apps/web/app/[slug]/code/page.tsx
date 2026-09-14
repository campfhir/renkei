import { notFound, redirect } from 'next/navigation';
import { getDatabase } from '@renkei/db';
import { sandboxWorkspacesEnabled } from '@renkei/sandbox-client';
import { tenantForSlug } from '@/lib/tenant-slug';
import { getSessionFromCookies } from '@/lib/session';
import { signInUrl } from '@/lib/sign-in-url';
import { loadChatSidebar } from '@/lib/chat/sidebar';
import CodeIndex from './_components/code-index';

/**
 * Code projects: mine, and the ones shared with me or published to the
 * org. Each is a repository a chat can work in.
 */
export default async function CodePage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const tenant = await tenantForSlug(slug);
  if (!tenant) notFound();
  const session = await getSessionFromCookies(tenant.id);
  if (!session) redirect(signInUrl(tenant.id, `/${slug}/code`));
  const dbResult = getDatabase();
  if (!dbResult.ok) notFound();
  const sidebar = await loadChatSidebar(dbResult.val, tenant.id, session.subject);
  return (
    <CodeIndex slug={slug} projects={sidebar.code.projects} enabled={sandboxWorkspacesEnabled()} />
  );
}
