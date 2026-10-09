/**
 * One agent's memory — the owner, or a grantee through an unexpired
 * access grant (access-grants.ts); anyone else's agentId is a 404, never
 * a 403. GET returns the rolling summary plus the entry rows newest-first;
 * DELETE clears everything, the "start this agent fresh" switch.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getDatabase } from '@renkei/db';
import { readAgentMemory } from '@renkei/agents/memory';
import { getSessionFromRequest } from '@/lib/session';
import { resolveAgentAccess } from '@/lib/agents/access-grants';
import { unavailableMarker } from '@/lib/chat/content-crypto';
import { unavailableReasonOf } from '@/lib/chat/chat-keys';

const MAX_LISTED_ENTRIES = 100;

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ tenantId: string; agentId: string }> }
): Promise<NextResponse> {
  const { agentId } = await params;
  const session = await getSessionFromRequest(request, tenantId);
  if (!session) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });

  const dbResult = getDatabase();
  if (!dbResult.ok) return NextResponse.json({ error: 'Database unavailable' }, { status: 500 });
  const db = dbResult.val;

  // Access check via the same resolver every agent item route uses.
  const access = await resolveAgentAccess(db, tenantId, session.subject, agentId);
  if (!access) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  // Rows are sealed under the owner's automation key; readAgentMemory
  // opens them through the delegate. When that key is not available the
  // answer says so (the chat's marker for a locked row) rather than
  // showing envelopes or nothing.
  const memory = await readAgentMemory(db, tenantId, agentId, { maxEntries: MAX_LISTED_ENTRIES });
  return NextResponse.json({
    summary:
      memory.summary !== null
        ? { content: memory.summary, updatedAt: memory.summaryUpdatedAt }
        : null,
    entries: memory.entries.map((entry) => ({
      id: entry.id,
      content: entry.content,
      createdAt: entry.createdAt,
    })),
    ...(memory.unavailable
      ? { unavailable: unavailableMarker(unavailableReasonOf(memory.unavailable)) }
      : {}),
  });
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ tenantId: string; agentId: string }> }
): Promise<NextResponse> {
  const { agentId } = await params;
  const session = await getSessionFromRequest(request, tenantId);
  if (!session) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });

  const dbResult = getDatabase();
  if (!dbResult.ok) return NextResponse.json({ error: 'Database unavailable' }, { status: 500 });
  const db = dbResult.val;

  const access = await resolveAgentAccess(db, tenantId, session.subject, agentId);
  if (!access) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const deleted = await db
    .deleteFrom('agent_memories')
    .where('agent_id', '=', agentId)
    .executeTakeFirst();
  return NextResponse.json({ cleared: Number(deleted.numDeletedRows ?? 0) });
}
