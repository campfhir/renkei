/**
 * Chat search by content: `?q=` against the prompts and replies of every
 * chat the viewer's sidebar lists. The sidebar loader is the access
 * decision — the same set of chats it shows is the set searched — and
 * search.ts bounds the scan. Title matching stays in the client, where
 * the titles already are; this route answers only what the titles cannot.
 */

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { chatRequestContext } from '@/lib/chat/route-support';
import { loadChatSidebar } from '@/lib/chat/sidebar';
import { CHAT_SEARCH_MIN_CHARS, normalizeQuery, searchChatMessages } from '@/lib/chat/search';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ tenantId: string }> }
): Promise<Response> {
  const { tenantId } = await params;
  const ready = await chatRequestContext(request, tenantId);
  if (!ready.ok) return ready.response;
  const { db, session } = ready.context;
  const query = normalizeQuery(request.nextUrl.searchParams.get('q') ?? '');
  if (query.length < CHAT_SEARCH_MIN_CHARS) return NextResponse.json({ query, hits: [] });
  const sidebar = await loadChatSidebar(db, tenantId, session.subject);
  const hits = await searchChatMessages(
    db,
    tenantId,
    sidebar.chats.map((chat) => chat.id),
    query
  );
  return NextResponse.json({ query, hits });
}
