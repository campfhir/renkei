/**
 * Chats: the sidebar list and creation.
 *
 * Creating inside a project requires access to that project (any role —
 * members chat with the project's context); the chat itself is always
 * the creator's. In a code project any number of chats may be open at
 * once: each works in a worktree of its own (lib/code/turn.ts).
 *
 * `temporary: true` starts a temporary chat (lib/chat/temporary.ts),
 * which stands outside projects.
 *
 * Creating a chat in a code project also starts preparing its checkout —
 * the project's clone and the chat's worktree — in the background
 * (lib/code/checkout.ts), as does opening one ([chatId]/route.ts).
 */

import type { NextRequest } from 'next/server';
import { NextResponse, after } from 'next/server';
import { isUuid } from '@/lib/uuid';
import { preferredChatModelId } from '@/lib/chat/preferred-model';
import { chatRequestContext, jsonError, readJsonBody } from '@/lib/chat/route-support';
import { loadChatSidebar } from '@/lib/chat/sidebar';
import { createChat } from '@/lib/chat/store';
import { getProjectRow } from '@/lib/chat/projects';
import { resolveResourceAccess } from '@/lib/chat/access';
import { parseToolConfig } from '@/lib/chat/tool-config';
import { TEMPORARY_OUTSIDE_PROJECTS } from '@/lib/chat/temporary';
import { startCheckoutPreparation } from '@/lib/code/checkout';
import { getOrigin } from '@/lib/get-origin';

export async function GET(request: NextRequest): Promise<Response> {
  const ready = await chatRequestContext(request);
  if (!ready.ok) return ready.response;
  const { session } = ready.context;
  return NextResponse.json(await loadChatSidebar(session.subject));
}

export async function POST(request: NextRequest): Promise<Response> {
  const ready = await chatRequestContext(request);
  if (!ready.ok) return ready.response;
  const { session } = ready.context;
  const body = await readJsonBody(request);

  let projectId: string | null = null;
  if (typeof body.projectId === 'string' && body.projectId) {
    if (!isUuid(body.projectId)) return jsonError(404, 'not-found', 'No such project');
    const access = await resolveResourceAccess(session.subject, 'chat_project', body.projectId);
    if (!access) return jsonError(404, 'not-found', 'No such project');
    projectId = body.projectId;
  }
  const temporary = body.temporary === true;
  if (temporary && projectId) {
    return jsonError(400, 'temporary-project', TEMPORARY_OUTSIDE_PROJECTS);
  }
  // No model asked for: the project's own, else the person's preferred one.
  const llmModelId =
    typeof body.llmModelId === 'string' && isUuid(body.llmModelId)
      ? body.llmModelId
      : await preferredChatModelId(session.subject, projectId);
  const toolConfig = body.toolConfig === undefined ? null : parseToolConfig(body.toolConfig);
  const input = {
    ownerSubject: session.subject,
    llmModelId,
    toolConfig,
    thinkingEnabled: body.thinkingEnabled === true,
  };
  const project = projectId ? await getProjectRow(projectId) : null;
  const chatId = await createChat({
    ...input,
    projectId,
    autoMode: project?.kind === 'code',
    temporary,
  });
  // A code chat's checkout is prepared now, behind the answer, so its first
  // message finds the tools ready rather than waiting on the clone.
  if (project?.kind === 'code') {
    const origin = await getOrigin(request);
    after(() =>
      startCheckoutPreparation({
        chatId,
        subject: session.subject,
        ...(origin.ok ? { origin: origin.val } : {}),
      })
    );
  }
  return NextResponse.json({ chatId, llmModelId }, { status: 201 });
}
