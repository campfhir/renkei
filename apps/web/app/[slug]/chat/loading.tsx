import { ThreadSkeleton } from './_components/frame-skeleton';

/**
 * Shown while a chat loads — the thread's own shape, since /chat, /chat/new
 * and /chat/[chatId] all end in one. The sibling index pages (projects,
 * prompts, memory) carry their own loading.tsx beside them.
 */
export default function ChatLoading() {
  return <ThreadSkeleton />;
}
