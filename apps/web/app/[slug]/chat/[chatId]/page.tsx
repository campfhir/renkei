import { notFound, redirect } from 'next/navigation';
import { getDatabase } from '@renkei/db';
import { getSessionFromCookies } from '@/lib/session';
import { signInUrl } from '@/lib/sign-in-url';
import { resolveChatAccess } from '@/lib/chat/access';
import { loadChatView } from '@/lib/chat/chat-view';
import { listChatModels } from '@/lib/chat/models';
import { tenantBlobStoreConfigured } from '@renkei/blob-store';
import { getOrgSettings } from '@renkei/settings';
import { loadVoiceAvailability } from '@/lib/voice/availability';
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
  const session = await getSessionFromCookies();
  if (!session) redirect(signInUrl(`/chat/${chatId}`));
  const dbResult = getDatabase();
  if (!dbResult.ok) notFound();
  const db = dbResult.val;

  const access = await resolveChatAccess(db, session.subject, chatId);
  if (!access) notFound();
  const [view, models, uploadsEnabled, voice, orgSettings] = await Promise.all([
    loadChatView(db, access, session.subject),
    listChatModels(db),
    tenantBlobStoreConfigured(),
    // Null when the org has no voice service: the thread then shows
    // nothing about voice at all.
    loadVoiceAvailability(session.subject),
    getOrgSettings(),
  ]);
  return (
    <ChatThread
      key={view.chat.id}
      slug={slug}
      subject={session.subject}
      initialChat={view.chat}
      initialMessages={view.messages}
      models={models}
      uploadsEnabled={uploadsEnabled}
      massUploadThreshold={orgSettings.ok ? orgSettings.val.massUploadThreshold : 10}
      voice={voice}
    />
  );
}
