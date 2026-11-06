/**
 * A chat's task list (lib/chat/tasks/): the tasks, opened under the chat's
 * key, what the chat is waiting on when its model suspended on them, and
 * the turn running now — so the tasks dialog can show the plan and the
 * thread can see a woken turn begin. `?format=markdown` answers the list
 * as a Markdown checklist to save. Anyone who may read the chat may read it.
 */

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { chatRequestContext, jsonError } from '@/lib/chat/route-support';
import { resolveChatAccess } from '@/lib/chat/access';
import { getActiveTurn, toTurnView } from '@/lib/chat/turns';
import { tasksMarkdown } from '@/lib/chat/tasks/graph';
import { listTasks } from '@/lib/chat/tasks/store';
import { getTaskWait } from '@/lib/chat/tasks/wake';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ chatId: string }> }
): Promise<Response> {
  const { chatId } = await params;
  const ready = await chatRequestContext(request);
  if (!ready.ok) return ready.response;
  const access = await resolveChatAccess(ready.context.session.subject, chatId);
  if (!access) return jsonError(404, 'not-found', 'No such chat');
  const tasks = await listTasks(chatId, access.cipher);
  if (request.nextUrl.searchParams.get('format') === 'markdown') {
    return new Response(tasksMarkdown(tasks, { title: access.chat.title, results: true }), {
      headers: {
        'content-type': 'text/markdown; charset=utf-8',
        'content-disposition': 'attachment; filename="tasks.md"',
        'cache-control': 'no-store',
      },
    });
  }
  const [wait, active] = await Promise.all([getTaskWait(chatId), getActiveTurn(chatId)]);
  return NextResponse.json({ tasks, wait, activeTurn: active ? toTurnView(active) : null });
}
