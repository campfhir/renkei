import type { ReactNode } from 'react';
import { notFound, redirect } from 'next/navigation';
import { getDatabase } from '@renkei/db';
import { tenantForSlug } from '@/lib/tenant-slug';
import { getSessionFromCookies } from '@/lib/session';
import { signInUrl } from '@/lib/sign-in-url';
import { loadChatSidebar } from '@/lib/chat/sidebar';
import ChatShell from './_components/chat-shell';

/**
 * The chat's two-column shell: the sidebar (chats, projects, prompts)
 * beside whatever page is open. Signed-out visitors go to sign-in from
 * here; every page under it still checks the session for itself, since a
 * layout check does not re-run on partial navigations.
 */
export default async function ChatLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const tenant = await tenantForSlug(slug);
  if (!tenant) notFound();
  const session = await getSessionFromCookies(tenant.id);
  if (!session) redirect(signInUrl(tenant.id, `/${slug}/chat`));
  const dbResult = getDatabase();
  if (!dbResult.ok) notFound();

  const sidebar = await loadChatSidebar(dbResult.val, tenant.id, session.subject);
  return (
    <div data-wide-page className="h-[calc(100vh-6.5rem)] min-h-[24rem]">
      <ChatShell slug={slug} tenantId={tenant.id} sidebar={sidebar} subject={session.subject}>
        {children}
      </ChatShell>
    </div>
  );
}
