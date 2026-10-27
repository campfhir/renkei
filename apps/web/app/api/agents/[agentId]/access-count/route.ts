/**
 * Get the count of active (unexpired) access grants for an agent.
 * Available to the owner only; non-owners get a 404 (the agent itself is
 * a 404 to them unless they have a grant, so this is consistent).
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSessionFromRequest } from '@/lib/session';
import { getAgent } from '@/lib/agents/store';
import { countActiveAgentGrants } from '@/lib/agents/access-grants';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ agentId: string }> }
): Promise<NextResponse> {
  const { agentId } = await params;
  const session = await getSessionFromRequest(request);
  if (!session) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });

  // Verify owner
  const agent = await getAgent(session.subject, agentId);
  if (!agent) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  // Count unexpired grants only
  const count = await countActiveAgentGrants(agentId);
  return NextResponse.json({ count });
}
