/**
 * The toolset picker's data: connectors this person can offer a chat,
 * with tool counts, and which ones are on by default.
 */

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { chatRequestContext } from '@/lib/chat/route-support';
import { listChatConnectors } from '@/lib/chat/tool-surface';
import { CHAT_CORE_CONNECTORS } from '@/lib/chat/tool-config';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ tenantId: string }> }
): Promise<Response> {
  const { tenantId } = await params;
  const ready = await chatRequestContext(request, tenantId);
  if (!ready.ok) return ready.response;
  const { session } = ready.context;
  return NextResponse.json({
    connectors: await listChatConnectors(tenantId, session.subject),
    core: CHAT_CORE_CONNECTORS,
  });
}
