/**
 * One of a code project's previews, by name: GET its last log lines (any
 * member; `?lines=` up to the worker's ceiling), DELETE stops it
 * (editors) — what a chat's code_preview_logs and code_preview_stop do,
 * from the page. The relay that serves the preview itself is app/ below.
 */

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { validatePreviewName } from '@renkei/connector-sandbox';
import { clientFailure, sbPreviewLogs, sbPreviewStop } from '@renkei/sandbox-client';
import { jsonError } from '@/lib/chat/route-support';
import { codeProjectContext } from '@/lib/code/route-access';
import { codeProjectTarget } from '@/lib/code/scope';
import { recordAuditEvent } from '@/lib/audit-events';
import { logger } from '@/lib/logger';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ projectId: string; chatId?: string; name: string }> }
): Promise<Response> {
  const { projectId, chatId, name: rawName } = await params;
  const ready = await codeProjectContext(request, projectId, { chatId });
  if (!ready.ok) return ready.response;
  const name = validatePreviewName(rawName);
  if (!name.ok) return jsonError(404, 'not-found', 'No such preview');
  const lines = Number(request.nextUrl.searchParams.get('lines') ?? '');
  const got = await sbPreviewLogs(codeProjectTarget(projectId), {
    name: name.name,
    ...(Number.isFinite(lines) && lines > 0 ? { lines } : {}),
  });
  if (!got.ok) {
    const failure = clientFailure(got.err);
    if (failure.status !== 400 && failure.status !== 404) {
      logger[failure.status >= 500 ? 'error' : 'warn'](
        'Sandbox request failed ({status}): {error}',
        {
          component: 'api/code/projects/previews',
          subject: ready.context.session.subject,
          projectId,
          operation: 'logs',
          status: failure.status,
          error: 'message' in got.err && got.err.message ? got.err.message : failure.message,
        }
      );
    }
    return jsonError(failure.status, 'sandbox', failure.message);
  }
  return NextResponse.json(got.val);
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ projectId: string; chatId?: string; name: string }> }
): Promise<Response> {
  const { projectId, chatId, name: rawName } = await params;
  const ready = await codeProjectContext(request, projectId, { write: true, chatId });
  if (!ready.ok) return ready.response;
  const name = validatePreviewName(rawName);
  if (!name.ok) return jsonError(404, 'not-found', 'No such preview');
  const stopped = await sbPreviewStop(codeProjectTarget(projectId), name.name);
  if (!stopped.ok) {
    const failure = clientFailure(stopped.err);
    if (failure.status !== 400 && failure.status !== 404) {
      logger[failure.status >= 500 ? 'error' : 'warn'](
        'Sandbox request failed ({status}): {error}',
        {
          component: 'api/code/projects/previews',
          subject: ready.context.session.subject,
          projectId,
          operation: 'stopped',
          status: failure.status,
          error:
            'message' in stopped.err && stopped.err.message ? stopped.err.message : failure.message,
        }
      );
    }
    return jsonError(failure.status, 'sandbox', failure.message);
  }
  recordAuditEvent({
    actorSubject: ready.context.session.subject,
    action: 'code.previews.stopped',
    targetKind: 'code_project',
    targetLabel: ready.context.project.name,
    details: { projectId, chatId: chatId ?? null, name: stopped.val.name, port: stopped.val.port },
  });
  return NextResponse.json({ preview: stopped.val });
}
