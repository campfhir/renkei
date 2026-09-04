import { notFound, redirect } from 'next/navigation';
import { getDatabase } from '@renkei/db';
import { tenantForSlug } from '@/lib/tenant-slug';
import { getSessionFromCookies } from '@/lib/session';
import { signInUrl } from '@/lib/sign-in-url';
import { resolveChatAccess } from '@/lib/chat/access';
import { loadChatView } from '@/lib/chat/chat-view';
import { listChatModels } from '@/lib/chat/models';
import ChatThread from '../_components/chat-thread';

/**
 * One chat. The owner gets the composer; a viewer (shared by name, or a
 * fellow member of the chat's project) reads it and watches it live.
 * Someone with neither gets a 404, never a 403.
 */
export default async function ChatPage({
  params,
}: {
  params: Promise<{ slug: string; chatId: string }>;
}) {
  const { slug, chatId } = await params;
  const tenant = await tenantForSlug(slug);
  if (!tenant) notFound();
  const session = await getSessionFromCookies(tenant.id);
  if (!session) redirect(signInUrl(tenant.id, `/${slug}/chat/${chatId}`));
  const dbResult = getDatabase();
  if (!dbResult.ok) notFound();
  const db = dbResult.val;

  const access = await resolveChatAccess(db, tenant.id, session.subject, chatId);
  if (!access) notFound();
  const [view, models] = await Promise.all([
    loadChatView(db, tenant.id, access, session.subject),
    listChatModels(db, tenant.id),
  ]);
  return (
    <ChatThread
      key={view.chat.id}
      slug={slug}
      tenantId={tenant.id}
      subject={session.subject}
      initialChat={view.chat}
      initialMessages={view.messages}
      models={models}
      newChatProject={null}
    />
  );
}
