/**
 * Get the count of active (unexpired) access grants for an agent.
 * Available to the owner only; non-owners get a 404 (the agent itself is
 * a 404 to them unless they have a grant, so this is consistent).
 */

import { NextRequest, NextResponse } from 'next/server';
import { sql } from 'kysely';
import { getDatabase, type DB } from '@renkei/db';
import { getSessionFromRequest } from '@/lib/session';
import { getAgent } from '@/lib/agents/store';

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

  // Verify owner
  const agent = await getAgent(db, tenantId, session.subject, agentId);
  if (!agent) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  // Count unexpired grants only
  const result = await sql<{ count: number }>`
    SELECT COUNT(*) AS count
    FROM agent_access_grants
    WHERE tenant_id = ${tenantId}
      AND agent_id = ${agentId}
      AND (expires_at IS NULL OR expires_at > NOW())
  `.execute(db);

  const count = result.rows[0]?.count ?? 0;
  return NextResponse.json({ count });
}
