/**
 * One language server session, from the editor's side.
 *
 * POST: one JSON-RPC message from the editor to the server (the body is
 * the message; the worker checks it — no lifecycle methods, no file
 * outside the checkout — and answers 202). GET: the server's messages
 * to the editor as a `text/event-stream`, the worker's own stream
 * relayed byte for byte, ended when the browser goes. DELETE: shut the
 * server down.
 *
 * `runtime = 'nodejs'`: a stream held open for as long as the editor is,
 * which the edge runtime's budget is not built for.
 */

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { LSP_MESSAGE_MAX_BYTES } from '@renkei/connector-sandbox';
import { clientFailure, sbLspClose, sbLspEvents, sbLspSend } from '@renkei/sandbox-client';
import { jsonError } from '@/lib/chat/route-support';
import { codeProjectContext } from '@/lib/code/route-access';
import { codeProjectTarget } from '@/lib/code/scope';
import { isUuid } from '@/lib/uuid';

export const runtime = 'nodejs';

type Params = { params: Promise<{ tenantId: string; projectId: string; sessionId: string }> };

export async function POST(request: NextRequest, { params }: Params): Promise<Response> {
  const { tenantId, projectId, sessionId } = await params;
  if (!isUuid(sessionId)) return jsonError(404, 'not-found', 'No such session.');
  const ready = await codeProjectContext(request, tenantId, projectId);
  if (!ready.ok) return ready.response;
  const declared = Number(request.headers.get('content-length') ?? '0');
  if (declared > LSP_MESSAGE_MAX_BYTES)
    return jsonError(413, 'too-large', 'The message is too large.');
  let message: unknown;
  try {
    message = await request.json();
  } catch {
    return jsonError(400, 'invalid', 'A message is JSON.');
  }
  const sent = await sbLspSend(codeProjectTarget(tenantId, projectId), {
    session: sessionId,
    message,
  });
  if (!sent.ok) {
    const failure = clientFailure(sent.err);
    return jsonError(
      failure.status,
      sent.err.kind === 'op' ? sent.err.type : 'lsp',
      failure.message
    );
  }
  return new Response(null, { status: 202 });
}

export async function GET(request: NextRequest, { params }: Params): Promise<Response> {
  const { tenantId, projectId, sessionId } = await params;
  if (!isUuid(sessionId)) return jsonError(404, 'not-found', 'No such session.');
  const ready = await codeProjectContext(request, tenantId, projectId);
  if (!ready.ok) return ready.response;
  // The worker's stream ends when this request does: the browser closing
  // the EventSource aborts the relay, which aborts the upstream.
  const controller = new AbortController();
  request.signal.addEventListener('abort', () => controller.abort());
  const events = await sbLspEvents(
    codeProjectTarget(tenantId, projectId),
    { session: sessionId },
    controller.signal
  );
  if (!events.ok) {
    const failure = clientFailure(events.err);
    return jsonError(failure.status, 'lsp', failure.message);
  }
  return new Response(events.val, {
    status: 200,
    headers: {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    },
  });
}

export async function DELETE(request: NextRequest, { params }: Params): Promise<Response> {
  const { tenantId, projectId, sessionId } = await params;
  if (!isUuid(sessionId)) return jsonError(404, 'not-found', 'No such session.');
  const ready = await codeProjectContext(request, tenantId, projectId);
  if (!ready.ok) return ready.response;
  const closed = await sbLspClose(codeProjectTarget(tenantId, projectId), { session: sessionId });
  return NextResponse.json({ closed: closed.ok && closed.val });
}
