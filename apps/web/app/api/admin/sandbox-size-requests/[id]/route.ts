/** Approve or deny one request for a larger checkout. */

import { NextRequest, NextResponse } from 'next/server';
import { checkAccess, ROLE_OPERATOR } from '@/lib/access';
import { getDatabase } from '@renkei/db';
import { WORKSPACE_LIMIT_MAX_BYTES, WORKSPACE_LIMIT_MIN_BYTES } from '@renkei/connector-sandbox';
import { recordAuditEvent } from '@/lib/audit-events';
import { decideSizeRequest } from '@/lib/code/size-requests';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  const { id } = await params;
  const access = await checkAccess([ROLE_OPERATOR]);
  if (!access) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (!/^[0-9a-f-]{36}$/i.test(id)) {
    return NextResponse.json({ error: 'No such request' }, { status: 404 });
  }

  const body: unknown = await request.json().catch(() => null);
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return NextResponse.json({ error: 'JSON body required' }, { status: 400 });
  }
  const fields: Record<string, unknown> = { ...body };
  const { decision, note, approvedBytes } = fields;
  if (decision !== 'approved' && decision !== 'denied') {
    return NextResponse.json({ error: 'decision must be approved or denied' }, { status: 400 });
  }
  let approved: number | undefined;
  if (approvedBytes !== undefined) {
    if (
      typeof approvedBytes !== 'number' ||
      !Number.isFinite(approvedBytes) ||
      approvedBytes < WORKSPACE_LIMIT_MIN_BYTES ||
      approvedBytes > WORKSPACE_LIMIT_MAX_BYTES
    ) {
      return NextResponse.json(
        { error: 'approvedBytes is outside the allowed range' },
        { status: 400 }
      );
    }
    approved = Math.trunc(approvedBytes);
  }
  const db = getDatabase();
  if (!db.ok) return NextResponse.json({ error: 'Database unavailable' }, { status: 500 });

  const outcome = await decideSizeRequest(db.val, {
    id,
    decision,
    decidedBy: access.subject,
    note: typeof note === 'string' && note.trim() ? note.trim().slice(0, 1000) : null,
    approvedBytes: approved,
  });
  if (!outcome.ok) {
    return NextResponse.json({ error: 'That request is not pending' }, { status: 409 });
  }
  recordAuditEvent({
    actorSubject: access.subject,
    action: 'code.size_request_decided',
    targetKind: 'code_project',
    targetLabel: outcome.request.projectName,
    details: {
      decision,
      requestedBytes: outcome.request.requestedBytes,
      requestedBy: outcome.request.requestedBy,
    },
  });
  return NextResponse.json({ request: outcome.request });
}
