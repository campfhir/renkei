/**
 * Ask for a larger checkout for this code project than the org's limit
 * allows (any member of the project). An admin approves or denies from
 * Admin → Settings; an approval raises this project's limit only.
 */

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { chatRequestContext, jsonError, readJsonBody } from '@/lib/chat/route-support';
import { resolveResourceAccess } from '@/lib/chat/access';
import { getProjectRow } from '@/lib/chat/projects';
import { getOrgSettings } from '@renkei/settings';
import { recordAuditEvent } from '@/lib/audit-events';
import { createSizeRequest, validReason, validRequestedBytes } from '@/lib/code/size-requests';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ tenantId: string; projectId: string }> }
): Promise<Response> {
  const { projectId } = await params;
  const ready = await chatRequestContext(request, tenantId);
  if (!ready.ok) return ready.response;
  const { db, session } = ready.context;
  const access = await resolveResourceAccess(
    db,
    session.subject,
    'chat_project',
    projectId
  );
  const project = access ? await getProjectRow(db, tenantId, projectId) : null;
  if (!project || project.kind !== 'code') return jsonError(404, 'not-found', 'No such project');

  const body = await readJsonBody(request);
  const settings = await getOrgSettings(tenantId);
  if (!settings.ok) return jsonError(500, 'settings', 'Could not read org settings');
  const bytes = validRequestedBytes(body.requestedBytes, settings.val.sandboxWorkspaceMaxBytes);
  if (typeof bytes === 'string') return jsonError(400, 'bad-request', bytes);
  const reason = validReason(body.reason);
  if (!reason)
    return jsonError(400, 'bad-request', 'Say why you need more space (up to 1000 characters)');

  const created = await createSizeRequest(db, {
    projectId,
    projectName: project.name,
    requestedBy: session.subject,
    requestedBytes: bytes,
    reason,
  });
  if (!created) {
    return jsonError(409, 'already-pending', 'A request for this project is already waiting');
  }
  recordAuditEvent({
    actorSubject: session.subject,
    action: 'code.size_requested',
    targetKind: 'code_project',
    targetLabel: project.name,
    details: { projectId, requestedBytes: bytes },
  });
  return NextResponse.json({ request: created }, { status: 201 });
}
