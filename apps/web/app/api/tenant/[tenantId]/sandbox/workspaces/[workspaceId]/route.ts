/**
 * One code workspace: its current state (GET — the connectors page polls
 * this while a clone runs) and its removal (DELETE). Both scoped by the
 * session's own subject on the worker; someone else's workspace is a 404.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSessionFromRequest } from '@/lib/session';
import { recordAuditEvent } from '@/lib/audit-events';
import {
  clientFailure,
  sandboxWorkspacesEnabled,
  sbWorkspaceDelete,
  sbWorkspaceGet,
} from '@/lib/sandbox/service-client';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ tenantId: string; workspaceId: string }> }
): Promise<NextResponse> {
  const { tenantId, workspaceId } = await params;
  const session = await getSessionFromRequest(request, tenantId);
  if (!session) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });
  if (!sandboxWorkspacesEnabled())
    return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const got = await sbWorkspaceGet({ tenantId, subject: session.subject }, workspaceId);
  if (!got.ok) {
    const failure = clientFailure(got.err);
    return NextResponse.json({ error: failure.message }, { status: failure.status });
  }
  return NextResponse.json({ workspace: got.val });
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ tenantId: string; workspaceId: string }> }
): Promise<NextResponse> {
  const { tenantId, workspaceId } = await params;
  const session = await getSessionFromRequest(request, tenantId);
  if (!session) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });
  if (!sandboxWorkspacesEnabled())
    return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const deleted = await sbWorkspaceDelete({ tenantId, subject: session.subject }, workspaceId);
  if (!deleted.ok) {
    const failure = clientFailure(deleted.err);
    return NextResponse.json({ error: failure.message }, { status: failure.status });
  }
  recordAuditEvent({
    tenantId,
    actorSubject: session.subject,
    action: 'sandbox.workspace.deleted',
    targetKind: 'sandbox_workspace',
    targetLabel: deleted.val.repoFullName,
    details: { workspaceId },
  });
  return NextResponse.json({ deleted: true });
}
