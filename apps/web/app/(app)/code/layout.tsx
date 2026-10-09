import type { ReactNode } from 'react';
import { notFound, redirect } from 'next/navigation';
import { getSessionFromCookies } from '@/lib/session';
import { signInUrl } from '@/lib/sign-in-url';
import ChatFrame from '../chat/_components/chat-frame';

/**
 * The Code pages' frame — the chat pages' own (a code project is a chat
 * project with a repository on it, and its chats are ordinary chat
 * pages). Signed-out visitors go to sign-in from here; every page under
 * it still checks the session for itself.
 */
export default async function CodeLayout({ children }: {
  children: ReactNode;
}) {
  const session = await getSessionFromCookies();
  if (!session) redirect(signInUrl(`/code`));
  return (
    <ChatFrame>
      <div className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden bg-white dark:bg-gray-950">
        {children}
      </div>
    </ChatFrame>
  );
}
