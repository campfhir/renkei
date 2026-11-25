import React from 'react';
import { redirect } from 'next/navigation';
import { getOrgSettings } from '@renkei/settings';
import { CHAT_ARCHIVE_MAX_DAYS, getChatArchivePrefs } from '@renkei/user-prefs';
import { getSessionFromCookies } from '@/lib/session';
import { signInUrl } from '@/lib/sign-in-url';
import { listChatConnectors } from '@/lib/chat/tool-surface';
import { getDefaultChatTools } from '@/lib/chat/tool-prefs';
import { PreferencesSectionBody } from '../section-body';
import ChatArchiveForm from '../chat-archive-form';
import DefaultToolsForm from '../default-tools-form';
import { chatToolOptions } from '../tool-options';

/** Preferences › Chats: archiving old chats, and the tools a new chat starts with. */
export default async function ChatsPage(): Promise<React.ReactNode> {
  const session = await getSessionFromCookies();
  if (!session) redirect(signInUrl(`/preferences/chats`));
  const [chatArchive, org, chatConnectors, chatDefault] = await Promise.all([
    getChatArchivePrefs(session.subject, { fresh: true }),
    getOrgSettings(),
    listChatConnectors(session.subject),
    getDefaultChatTools(session.subject, { fresh: true }),
  ]);
  const retentionDays = org.ok ? org.val.chatRetentionDays : 0;
  return (
    <PreferencesSectionBody
      title="Chats"
      description="How long chats stay in your list, and the tools a new chat starts with."
    >
      <ChatArchiveForm
        initial={chatArchive}
        retentionDays={retentionDays}
        maxDays={
          retentionDays > 0 ? Math.min(retentionDays, CHAT_ARCHIVE_MAX_DAYS) : CHAT_ARCHIVE_MAX_DAYS
        }
      />
      <DefaultToolsForm
        connectors={chatToolOptions(chatConnectors)}
        initialDefault={chatDefault?.connectors ?? null}
      />
    </PreferencesSectionBody>
  );
}
