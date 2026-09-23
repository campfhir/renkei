/**
 * One of a code project's services, by name: GET its last log lines
 * (any member; `?lines=` up to the worker's ceiling), DELETE stops and
 * removes it with its data (editors) — what a chat's code_service_stop
 * does, from the page.
 */

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { validateServiceName } from '@renkei/connector-sandbox';
import {
  clientFailure,
  sandboxServicesEnabled,
  sbServiceLogs,
  sbServiceStop,
} from '@renkei/sandbox-client';
import { jsonError } from '@/lib/chat/route-support';
import { codeProjectContext } from '@/lib/code/route-access';
import { codeProjectTarget } from '@/lib/code/scope';
import { recordAuditEvent } from '@/lib/audit-events';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ tenantId: string; projectId: string; name: string }> }
): Promise<Response> {
  const { tenantId, projectId, name: rawName } = await params;
  const ready = await codeProjectContext(request, tenantId, projectId);
  if (!ready.ok) return ready.response;
  const name = validateServiceName(rawName);
  if (!name.ok) return jsonError(404, 'not-found', 'No such service');
  if (!sandboxServicesEnabled()) {
    return jsonError(
      503,
      'unavailable',
      'Code project services are not enabled on this deployment.'
    );
  }
  const lines = Number(request.nextUrl.searchParams.get('lines') ?? '');
  const got = await sbServiceLogs(codeProjectTarget(tenantId, projectId), {
    name: name.name,
    ...(Number.isFinite(lines) && lines > 0 ? { lines } : {}),
  });
  if (!got.ok) {
    const failure = clientFailure(got.err);
    return jsonError(failure.status, 'sandbox', failure.message);
  }
  return NextResponse.json(got.val);
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ tenantId: string; projectId: string; name: string }> }
): Promise<Response> {
  const { tenantId, projectId, name: rawName } = await params;
  const ready = await codeProjectContext(request, tenantId, projectId, { write: true });
  if (!ready.ok) return ready.response;
  const name = validateServiceName(rawName);
  if (!name.ok) return jsonError(404, 'not-found', 'No such service');
  if (!sandboxServicesEnabled()) {
    return jsonError(
      503,
      'unavailable',
      'Code project services are not enabled on this deployment.'
    );
  }
  const stopped = await sbServiceStop(codeProjectTarget(tenantId, projectId), name.name);
  if (!stopped.ok) {
    const failure = clientFailure(stopped.err);
    return jsonError(failure.status, 'sandbox', failure.message);
  }
  recordAuditEvent({
    tenantId,
    actorSubject: ready.context.session.subject,
    action: 'code.services.stopped',
    targetKind: 'code_project',
    targetLabel: ready.context.project.name,
    details: { projectId, name: stopped.val.name, image: stopped.val.image },
  });
  return NextResponse.json({ service: stopped.val });
}
