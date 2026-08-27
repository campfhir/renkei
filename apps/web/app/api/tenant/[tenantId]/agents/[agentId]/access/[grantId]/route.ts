/**
 * One access grant — DELETE revokes it. Owner only, structurally: the
 * delete is keyed by the caller's subject as owner, so someone else's
 * grant row is a 404.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getDatabase } from '@renkei/db';
import { getSessionFromRequest } from '@/lib/session';
import { getAgent } from '@/lib/agents/store';
import { revokeAgentAccessGrant } from '@/lib/agents/access-grants';
import { recordAuditEvent } from '@/lib/audit-events';

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ tenantId: string; agentId: string; grantId: string }> }
): Promise<NextResponse> {
  const { tenantId, agentId, grantId } = await params;
  const session = await getSessionFromRequest(request, tenantId);
  if (!session) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });

  const dbResult = getDatabase();
  if (!dbResult.ok) return NextResponse.json({ error: 'Database unavailable' }, { status: 500 });
  const db = dbResult.val;

  const agent = await getAgent(db, tenantId, session.subject, agentId);
  if (!agent) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const revoked = await revokeAgentAccessGrant(db, tenantId, session.subject, agentId, grantId);
  if (!revoked) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  recordAuditEvent({
    tenantId,
    actorSubject: session.subject,
    action: 'agent.access_revoked',
    targetKind: 'agent',
    targetLabel: agent.name,
    details: { granteeSubject: revoked.granteeSubject },
  });
  return NextResponse.json({ ok: true });
}
