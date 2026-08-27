/**
 * One agent's memory — the owner, or a grantee through an unexpired
 * access grant (access-grants.ts); anyone else's agentId is a 404, never
 * a 403. GET returns the rolling summary plus the entry rows newest-first;
 * DELETE clears everything, the "start this agent fresh" switch.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getDatabase } from '@renkei/db';
import { getSessionFromRequest } from '@/lib/session';
import { resolveAgentAccess } from '@/lib/agents/access-grants';

const MAX_LISTED_ENTRIES = 100;

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ tenantId: string; agentId: string }> }
): Promise<NextResponse> {
  const { tenantId, agentId } = await params;
  const session = await getSessionFromRequest(request, tenantId);
  if (!session) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });

  const dbResult = getDatabase();
  if (!dbResult.ok) return NextResponse.json({ error: 'Database unavailable' }, { status: 500 });
  const db = dbResult.val;

  // Access check via the same resolver every agent item route uses.
  const access = await resolveAgentAccess(db, tenantId, session.subject, agentId);
  if (!access) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const rows = await db
    .selectFrom('agent_memories')
    .select(['id', 'kind', 'content', 'created_at', 'updated_at'])
    .where('tenant_id', '=', tenantId)
    .where('agent_id', '=', agentId)
    .orderBy('created_at', 'desc')
    .orderBy('id', 'desc')
    .limit(MAX_LISTED_ENTRIES + 1)
    .execute();

  const summaryRow = rows.find((row) => row.kind === 'summary');
  return NextResponse.json({
    summary: summaryRow ? { content: summaryRow.content, updatedAt: summaryRow.updated_at } : null,
    entries: rows
      .filter((row) => row.kind === 'entry')
      .slice(0, MAX_LISTED_ENTRIES)
      .map((row) => ({ id: row.id, content: row.content, createdAt: row.created_at })),
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
  const db = dbResult.val;

  const access = await resolveAgentAccess(db, tenantId, session.subject, agentId);
  if (!access) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const deleted = await db
    .deleteFrom('agent_memories')
    .where('tenant_id', '=', tenantId)
    .where('agent_id', '=', agentId)
    .executeTakeFirst();
  return NextResponse.json({ cleared: Number(deleted.numDeletedRows ?? 0) });
}
