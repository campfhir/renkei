/**
 * This chat's most recent pull request, read off its own transcript
 * (lib/code/chat-commits.ts's latestPrInTranscript) — the small badge a
 * project's chat list and the chat's own title bar show. A chat can
 * touch several PRs over its life; this is deliberately just the
 * newest create/merge event, not a full history.
 */

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { chatRequestContext, jsonError } from '@/lib/chat/route-support';
import { resolveChatAccess } from '@/lib/chat/access';
import { listMessages, toMessageView } from '@/lib/chat/messages';
import { latestPrInTranscript } from '@/lib/code/chat-commits';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ tenantId: string; chatId: string }> }
): Promise<Response> {
  const { tenantId, chatId } = await params;
  const ready = await chatRequestContext(request, tenantId);
  if (!ready.ok) return ready.response;
  const { db, session } = ready.context;
  const access = await resolveChatAccess(db, tenantId, session.subject, chatId);
  if (!access) return jsonError(404, 'not-found', 'No such chat');
  const rows = await listMessages(db, tenantId, chatId);
  const pullRequest = latestPrInTranscript(rows.map(toMessageView));
  return NextResponse.json({ pullRequest });
}
