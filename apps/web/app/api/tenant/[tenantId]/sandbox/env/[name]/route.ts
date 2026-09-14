/**
 * Remove one workspace environment variable (DELETE). The next command
 * the person's workspaces run no longer sees it.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSessionFromRequest } from '@/lib/session';
import { recordAuditEvent } from '@/lib/audit-events';
import { clientFailure, sandboxWorkspacesEnabled, sbEnvDelete } from '@/lib/sandbox/service-client';

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ tenantId: string; name: string }> }
): Promise<NextResponse> {
  const { tenantId, name } = await params;
  const session = await getSessionFromRequest(request, tenantId);
  if (!session) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });
  if (!sandboxWorkspacesEnabled())
    return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const deleted = await sbEnvDelete(
    { tenantId, subject: session.subject },
    decodeURIComponent(name)
  );
  if (!deleted.ok) {
    const failure = clientFailure(deleted.err);
    return NextResponse.json({ error: failure.message }, { status: failure.status });
  }
  recordAuditEvent({
    tenantId,
    actorSubject: session.subject,
    action: 'sandbox.env.deleted',
    targetKind: 'sandbox_env',
    targetLabel: deleted.val.name,
  });
  return NextResponse.json({ deleted: true });
}
