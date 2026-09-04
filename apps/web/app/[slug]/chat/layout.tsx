import type { ReactNode } from 'react';
import { notFound, redirect } from 'next/navigation';
import { getDatabase } from '@renkei/db';
import { tenantForSlug } from '@/lib/tenant-slug';
import { getSessionFromCookies } from '@/lib/session';
import { signInUrl } from '@/lib/sign-in-url';
import { loadChatSidebar } from '@/lib/chat/sidebar';
import ChatFrame from './_components/chat-frame';
import ChatNavSection from './_components/chat-nav';

/**
 * The chat pages' frame: the page fills the main column edge to edge, its
 * title bar directly under the top bar (the app menu beside it carries
 * the chat list, registered from here). Signed-out
 * visitors go to sign-in from here; every page under it still checks the
 * session for itself, since a layout check does not re-run on partial
 * navigations.
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
    <ChatFrame>
      <ChatNavSection slug={slug} tenantId={tenant.id} data={sidebar} />
      <div className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden bg-white dark:bg-gray-950">
        {children}
      </div>
    </ChatFrame>
  );
}
