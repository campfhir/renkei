/**
 * The person's hand on one task of their chat (the tasks dialog): PATCH
 * `{ action: 'complete' | 'cancel' }` finishes it the way the model's own
 * tools would (lib/chat/tasks/store.ts, by the same rules), DELETE removes
 * it with its subtasks. Either may wake a chat suspended on its tasks
 * (lib/chat/tasks/wake.ts). Owner only; answers the list as it now stands.
 */

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { chatRequestContext, jsonError, readJsonBody } from '@/lib/chat/route-support';
import { resolveChatAccess } from '@/lib/chat/access';
import { changeTask, deleteTask } from '@/lib/chat/tasks/store';
import { wakeSoon } from '@/lib/chat/tasks/wake';

type Params = { params: Promise<{ chatId: string; taskId: string }> };

async function ownerAccess(request: NextRequest, chatId: string) {
  const ready = await chatRequestContext(request);
  if (!ready.ok) return { ok: false as const, response: ready.response };
  const access = await resolveChatAccess(ready.context.session.subject, chatId);
  if (!access) return { ok: false as const, response: jsonError(404, 'not-found', 'No such chat') };
  if (access.role !== 'owner')
    return {
      ok: false as const,
      response: jsonError(403, 'forbidden', 'Only the chat’s owner changes its tasks.'),
    };
  return { ok: true as const, access };
}

export async function PATCH(request: NextRequest, { params }: Params): Promise<Response> {
  const { chatId, taskId } = await params;
  const owner = await ownerAccess(request, chatId);
  if (!owner.ok) return owner.response;
  const body = await readJsonBody(request);
  const action = body.action;
  if (action !== 'complete' && action !== 'cancel')
    return jsonError(400, 'invalid', 'action is complete or cancel.');
  const outcome = await changeTask(
    chatId,
    owner.access.cipher,
    taskId,
    action === 'complete'
      ? { status: 'completed', result: 'Marked complete by the person.' }
      : { status: 'cancelled', result: 'Cancelled by the person.' },
    new Date()
  );
  if (!outcome.ok) return jsonError(409, 'refused', outcome.reason);
  if (outcome.finished.length > 0) wakeSoon(chatId);
  return NextResponse.json({ tasks: outcome.tasks });
}

export async function DELETE(request: NextRequest, { params }: Params): Promise<Response> {
  const { chatId, taskId } = await params;
  const owner = await ownerAccess(request, chatId);
  if (!owner.ok) return owner.response;
  const deleted = await deleteTask(chatId, owner.access.cipher, taskId);
  if (!deleted.ok) return jsonError(404, 'not-found', deleted.reason);
  wakeSoon(chatId);
  return NextResponse.json({ tasks: deleted.tasks });
}
