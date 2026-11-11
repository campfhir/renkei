/**
 * The preview itself: everything under
 * `/api/code/projects/[projectId]/previews/[name]/app/` is relayed, as it
 * came, to the preview's server on the sandbox worker and its answer
 * streamed back — for a signed-in member of the project (the session is
 * checked; the session cookie is NOT forwarded). Any method, so a form
 * post and an API call work as well as a page. The same handler serves
 * `/chats/[chatId]/previews/[name]/app/`.
 */

import type { NextRequest } from 'next/server';
import { previewProxyPath, validatePreviewName } from '@renkei/connector-sandbox';
import { jsonError } from '@/lib/chat/route-support';
import { codeProjectContext } from '@/lib/code/route-access';
import { codeProjectTarget } from '@/lib/code/scope';
import { previewRelay } from '@/lib/code/previews';
import { hostMemberPath } from '@/lib/code/preview-host';
import { movedToPreviewHost } from '@/lib/code/preview-host-server';

type Params = Promise<{ projectId: string; chatId?: string; name: string; path?: string[] }>;

async function relay(request: NextRequest, { params }: { params: Params }): Promise<Response> {
  const { projectId, chatId, name: rawName, path } = await params;
  const ready = await codeProjectContext(request, projectId, { chatId });
  if (!ready.ok) return ready.response;
  const name = validatePreviewName(rawName);
  if (!name.ok) return jsonError(404, 'not-found', 'No such preview');
  const moved = await movedToPreviewHost(
    request,
    hostMemberPath({ projectId, chatId: chatId ?? null, name: name.name }),
    path
  );
  if (moved) return moved;
  return previewRelay(
    request,
    { subject: codeProjectTarget(projectId).subject, name: name.name },
    { prefix: previewProxyPath({ projectId, chatId: chatId ?? null, name: name.name }), path }
  );
}

export const GET = relay;
export const HEAD = relay;
export const POST = relay;
export const PUT = relay;
export const PATCH = relay;
export const DELETE = relay;
export const OPTIONS = relay;
