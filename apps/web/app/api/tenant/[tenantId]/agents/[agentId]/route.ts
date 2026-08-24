/**
 * One agent: read, update, delete — owner only. Someone else's agentId is
 * a 404, never a 403 (server-derived authority: the row is looked up by
 * the caller's own subject, so there is no "exists but forbidden" to leak).
 *
 * DELETE cascades the run history by FK design: deleting an agent is the
 * owner saying the whole thing goes.
 */

import { NextRequest, NextResponse } from 'next/server';
import { after } from 'next/server';
import { getDatabase } from '@renkei/db';
import { getSessionFromRequest } from '@/lib/session';
import { parseAgentPayload } from '@/lib/agents/payload';
import { deleteAgent, getAgent } from '@/lib/agents/store';
import { saveAgent } from '@/lib/agents/save';
import { recordAuditEvent } from '@/lib/audit-events';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ tenantId: string; agentId: string }> }
): Promise<NextResponse> {
  const { tenantId, agentId } = await params;
  const session = await getSessionFromRequest(request, tenantId);
  if (!session) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });

  const dbResult = getDatabase();
  if (!dbResult.ok) return NextResponse.json({ error: 'Database unavailable' }, { status: 500 });

  const agent = await getAgent(dbResult.val, tenantId, session.subject, agentId);
  if (!agent) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  return NextResponse.json({ agent });
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ tenantId: string; agentId: string }> }
): Promise<NextResponse> {
  const { tenantId, agentId } = await params;
  const session = await getSessionFromRequest(request, tenantId);
  if (!session) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });

  const dbResult = getDatabase();
  if (!dbResult.ok) return NextResponse.json({ error: 'Database unavailable' }, { status: 500 });

  const body = await request.json().catch(() => null);
  const parsed = parseAgentPayload(body);
  if ('error' in parsed) return NextResponse.json({ error: parsed.error }, { status: 400 });

  // The shared save path (normalize → validate → persist → audit); the
  // summary is written AFTER the response — the builder polls meanwhile.
  const result = await saveAgent(dbResult.val, tenantId, session.subject, parsed, {
    agentId,
    defer: after,
  });
  if (result.outcome === 'not-found') {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }
  // 'valid-dry-run' cannot happen (no dryRun passed); narrowing to 'saved'.
  if (result.outcome !== 'saved') {
    return NextResponse.json(
      { issues: result.outcome === 'invalid' ? result.issues : [] },
      { status: 422 }
    );
  }

  const agent = await getAgent(dbResult.val, tenantId, session.subject, agentId);
  return NextResponse.json({
    agent,
    apiKeys: result.apiKeys,
    descriptionPending: result.descriptionPending,
  });
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

  // Fetched first: after the cascade there is no row left to name in the
  // audit trail, and "deleted agent <uuid>" tells an operator nothing.
  const existing = await getAgent(dbResult.val, tenantId, session.subject, agentId);
  const deleted = await deleteAgent(dbResult.val, tenantId, session.subject, agentId);
  if (!deleted) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  recordAuditEvent({
    tenantId,
    actorSubject: session.subject,
    action: 'agent.deleted',
    targetKind: 'agent',
    targetLabel: existing?.name ?? agentId,
  });
  return NextResponse.json({ deleted: true });
}
