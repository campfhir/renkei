/**
 * Force a compaction pass on this chat right now, outside the model's own
 * chat_compact tool call — the person's own handle on compaction.ts. Owner
 * only; not while a reply is in progress, since that turn already built
 * its history from what compaction would change.
 */

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { resolveAgentLlm } from '@renkei/agent-llm';
import { chatRequestContext, jsonError } from '@/lib/chat/route-support';
import { compactChat } from '@/lib/chat/compaction';
import { getChatForOwner } from '@/lib/chat/store';
import { getActiveTurn } from '@/lib/chat/turns';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ tenantId: string; chatId: string }> }
): Promise<Response> {
  const { tenantId, chatId } = await params;
  const ready = await chatRequestContext(request, tenantId);
  if (!ready.ok) return ready.response;
  const { db, session } = ready.context;
  const chat = await getChatForOwner(db, tenantId, session.subject, chatId);
  if (!chat) return jsonError(404, 'not-found', 'No such chat');
  if (await getActiveTurn(db, chat.id)) {
    return jsonError(409, 'turn-running', 'Wait for the current reply to finish first.');
  }

  const llmResult = await resolveAgentLlm(db, tenantId, chat.llmModelId ?? null);
  if (!llmResult.ok) {
    return jsonError(
      409,
      'no-model',
      llmResult.err.message ?? 'No model is configured for this organization.'
    );
  }

  try {
    const result = await compactChat(db, {
      tenantId,
      chatId: chat.id,
      llm: llmResult.val,
      createdBy: 'user',
    });
    return NextResponse.json(
      result
        ? { ok: true, folded: result.foldedCount, summaryId: result.summaryId }
        : { ok: true, folded: 0 }
    );
  } catch (error) {
    return jsonError(
      502,
      'compaction-failed',
      error instanceof Error ? error.message : 'Compaction failed.'
    );
  }
}
