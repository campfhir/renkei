/**
 * "Load more" at the bottom of the sidebar's chat list: the next page of
 * the viewer's own chats older than `?before=`, the cursor the initial
 * sidebar load (or the previous page) handed back.
 */

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { chatRequestContext, jsonError } from '@/lib/chat/route-support';
import { loadMoreOwnedChats } from '@/lib/chat/sidebar';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ tenantId: string }> }
): Promise<Response> {
  const { tenantId } = await params;
  const ready = await chatRequestContext(request, tenantId);
  if (!ready.ok) return ready.response;
  const { db, session } = ready.context;
  const raw = request.nextUrl.searchParams.get('before');
  const before = raw ? new Date(raw) : null;
  if (!before || Number.isNaN(before.getTime())) {
    return jsonError(400, 'bad-request', 'A valid `before` timestamp is required');
  }
  const page = await loadMoreOwnedChats(db, tenantId, session.subject, before);
  return NextResponse.json(page);
}
