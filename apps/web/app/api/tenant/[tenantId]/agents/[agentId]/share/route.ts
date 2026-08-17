/**
 * The agent's share link — owner only. POST mints (or regenerates,
 * invalidating the old link) the token; DELETE turns sharing off. What a
 * holder can DO with the token lives in the copy route and the shared
 * page — this route only manages the capability's existence.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getDatabase } from '@renkei/db';
import { getSessionFromRequest } from '@/lib/session';
import { generateSecret } from '@/lib/mcp-token';
import { getAgent, setShareToken } from '@/lib/agents/store';
import { recordAuditEvent } from '@/lib/audit-events';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ tenantId: string; agentId: string }> }
): Promise<NextResponse> {
  const { tenantId, agentId } = await params;
  const session = await getSessionFromRequest(request, tenantId);
  if (!session) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });

  const dbResult = getDatabase();
  if (!dbResult.ok) return NextResponse.json({ error: 'Database unavailable' }, { status: 500 });
  const db = dbResult.val;

  const agent = await getAgent(db, tenantId, session.subject, agentId);
  if (!agent) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const token = generateSecret(24);
  const set = await setShareToken(db, tenantId, session.subject, agentId, token);
  if (!set) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  recordAuditEvent({
    tenantId,
    actorSubject: session.subject,
    action: 'agent.shared',
    targetKind: 'agent',
    targetLabel: agent.name,
  });
  return NextResponse.json({ token });
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ tenantId: string; agentId: string }> }
): Promise<NextResponse> {
  const { tenantId, agentId } = await params;
  const session = await getSessionFromRequest(request, tenantId);
  if (!session) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });

  const dbResult = getDatabase();
  if (!dbResult.ok) return NextResponse.json({ error: 'Database unavailable' }, { status: 500 });
  const db = dbResult.val;

  const agent = await getAgent(db, tenantId, session.subject, agentId);
  if (!agent) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  await setShareToken(db, tenantId, session.subject, agentId, null);
  recordAuditEvent({
    tenantId,
    actorSubject: session.subject,
    action: 'agent.unshared',
    targetKind: 'agent',
    targetLabel: agent.name,
  });
  return NextResponse.json({ ok: true });
}
