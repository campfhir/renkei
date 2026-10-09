import { notFound, redirect } from 'next/navigation';
import { getDatabase } from '@renkei/db';
import { getSessionFromCookies } from '@/lib/session';
import { signInUrl } from '@/lib/sign-in-url';
import { listOwnedChats } from '@/lib/chat/store';

/**
 * "Chat" in the menu: the person's most recent chat, picked up where it
 * was left — or, with no history yet, a new one. "+ New" goes to
 * /chat/new directly.
 */
export default async function ChatIndexPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const session = await getSessionFromCookies(tenant.id);
  if (!session) redirect(signInUrl(tenant.id, `/chat`));
  const dbResult = getDatabase();
  if (!dbResult.ok) notFound();

  const [latest] = await listOwnedChats(dbResult.val, tenant.id, session.subject);
  redirect(latest ? `/chat/${latest.id}` : `/chat/new`);
}
