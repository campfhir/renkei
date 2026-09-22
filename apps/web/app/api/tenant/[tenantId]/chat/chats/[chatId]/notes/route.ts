/**
 * A note row for a code chat's transcript (lib/code/notes.ts): what the
 * owner did to the checkout from the code pane — a save, a commit, a
 * push — as a structured note the server renders, never free text.
 * Owner only, in a code project's chat only; refused while a turn is
 * running (409 `turn-running`), and the pane sends it again when the
 * turn ends.
 */

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { chatRequestContext, jsonError, readJsonBody } from '@/lib/chat/route-support';
import { getProjectRow } from '@/lib/chat/projects';
import { getChatForOwner } from '@/lib/chat/store';
import { appendChatNote, noteFromInput } from '@/lib/code/notes';

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
  const project = chat.projectId ? await getProjectRow(db, tenantId, chat.projectId) : null;
  if (!project || project.kind !== 'code')
    return jsonError(400, 'invalid', 'Only a code project’s chat keeps editor notes.');
  const body = await readJsonBody(request);
  const note = noteFromInput(body.note);
  if (!note) return jsonError(400, 'invalid', 'That is not a note the pane writes.');
  const appended = await appendChatNote(db, { tenantId, chatId: chat.id, note });
  if (!appended.ok) {
    return appended.reason === 'turn-running'
      ? jsonError(409, 'turn-running', 'Wait for the current reply to finish first.')
      : jsonError(500, 'failed', 'The note could not be written.');
  }
  return NextResponse.json({ message: appended.message });
}
