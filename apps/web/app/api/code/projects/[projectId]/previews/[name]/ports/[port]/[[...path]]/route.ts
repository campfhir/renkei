/**
 * One named port of a preview: everything under
 * `/api/code/projects/[projectId]/previews/[name]/ports/[port]/` is relayed
 * to that port of the preview's server, as `…/app/` relays the first port
 * (app/[[...path]]/route.ts) — a UI's API on the same preview, a second
 * service a monorepo's dev script starts. The same handler serves
 * `/chats/[chatId]/previews/[name]/ports/[port]/`.
 */

import type { NextRequest } from 'next/server';
import {
  previewProxyPath,
  validatePreviewName,
  validatePreviewPortName,
} from '@renkei/connector-sandbox';
import { jsonError } from '@/lib/chat/route-support';
import { codeProjectContext } from '@/lib/code/route-access';
import { codeProjectTarget } from '@/lib/code/scope';
import { previewRelay } from '@/lib/code/previews';

type Params = Promise<{
  projectId: string;
  chatId?: string;
  name: string;
  port: string;
  path?: string[];
}>;

async function relay(request: NextRequest, { params }: { params: Params }): Promise<Response> {
  const { projectId, chatId, name: rawName, port: rawPort, path } = await params;
  const ready = await codeProjectContext(request, projectId, { chatId });
  if (!ready.ok) return ready.response;
  const name = validatePreviewName(rawName);
  const port = validatePreviewPortName(rawPort);
  if (!name.ok || !port.ok) return jsonError(404, 'not-found', 'No such preview port');
  return previewRelay(
    request,
    { subject: codeProjectTarget(projectId).subject, name: name.name, port: port.name },
    {
      prefix: previewProxyPath({
        projectId,
        chatId: chatId ?? null,
        name: name.name,
        port: port.name,
      }),
      path,
    }
  );
}

export const GET = relay;
export const HEAD = relay;
export const POST = relay;
export const PUT = relay;
export const PATCH = relay;
export const DELETE = relay;
export const OPTIONS = relay;
