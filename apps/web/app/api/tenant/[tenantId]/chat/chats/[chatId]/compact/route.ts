/**
 * Force a compaction pass on this chat right now — asked for in chat text
 * ("compact this") or /compact (chat-thread.tsx, prompt-picker.tsx), never
 * a button. Answers 202 with the new turn's id, same shape as Send
 * (turns/route.ts): the page streams its progress and completion from
 * turns/[turnId]/stream exactly like a reply, and runCompactionTurn does
 * the work after the response (compaction.ts).
 */

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { chatRequestContext, jsonError } from '@/lib/chat/route-support';
import { startCompactionTurn } from '@/lib/chat/compaction';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ tenantId: string; chatId: string }> }
): Promise<Response> {
  const { tenantId, chatId } = await params;
  const ready = await chatRequestContext(request, tenantId);
  if (!ready.ok) return ready.response;
  const { db, session } = ready.context;

  const started = await startCompactionTurn(db, {
    tenantId,
    session: { subject: session.subject, roles: session.roles },
    chatId,
  });
  if (!started.ok) {
    switch (started.err.type) {
      case 'NOT_FOUND':
        return jsonError(404, 'not-found', 'No such chat');
      case 'FORBIDDEN':
        return jsonError(403, 'read-only', 'Only the owner can continue this chat.');
      case 'ALREADY_RUNNING':
        return jsonError(409, 'turn-running', 'A reply is already in progress.');
      case 'NO_MODEL':
        return jsonError(
          409,
          'no-model',
          'No model is configured for this organization. An administrator can add one under Agent models.'
        );
      case 'MODEL_ERROR':
        return jsonError(409, 'model-error', started.err.message ?? 'The model is not usable.');
      default:
        return jsonError(500, 'database', 'Compaction could not be started.');
    }
  }
  return NextResponse.json(started.val, { status: 202 });
}
