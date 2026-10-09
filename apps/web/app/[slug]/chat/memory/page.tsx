import { notFound, redirect } from 'next/navigation';
import { getDatabase } from '@renkei/db';
import { getSessionFromCookies } from '@/lib/session';
import { signInUrl } from '@/lib/sign-in-url';
import { readUserMemory } from '@/lib/chat/user-memory';
import MemoryIndex from '../_components/memory-index';

/**
 * Memory: alongside Projects and Prompt libraries under Chat, not tucked
 * inside Preferences — it is what chats do, not a setting about them.
 */
export default async function ChatMemoryPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const session = await getSessionFromCookies();
  if (!session) redirect(signInUrl(`/chat/memory`));
  const dbResult = getDatabase();
  if (!dbResult.ok) notFound();
  const memory = await readUserMemory(dbResult.val, session.subject, {
    maxEntries: 300,
  });
  return (
    <MemoryIndex
      initialSummary={memory.summary}
      initialEntries={memory.entries.map((entry) => ({
        id: entry.id,
        content: entry.content,
        chatId: entry.chatId,
        createdAt: entry.createdAt.toISOString(),
      }))}
    />
  );
}
