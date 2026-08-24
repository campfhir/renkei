/**
 * Your agents: list and create.
 *
 * The save itself — normalize against org caps, validate against THIS
 * caller's tool projection, persist, audit, describe — is the shared
 * saveAgent path (lib/agents/save.ts), which the MCP agents tools run
 * through too. This route is the HTTP translation around it.
 *
 * A create returns any freshly minted API-trigger keys exactly once; only
 * their SHA-256 digests are stored.
 */

import { NextRequest, NextResponse } from 'next/server';
import { after } from 'next/server';
import { getDatabase } from '@renkei/db';
import { getSessionFromRequest } from '@/lib/session';
import { parseAgentPayload } from '@/lib/agents/payload';
import { listAgents } from '@/lib/agents/store';
import { saveAgent } from '@/lib/agents/save';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ tenantId: string }> }
): Promise<NextResponse> {
  const { tenantId } = await params;
  const session = await getSessionFromRequest(request, tenantId);
  if (!session) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });

  const dbResult = getDatabase();
  if (!dbResult.ok) return NextResponse.json({ error: 'Database unavailable' }, { status: 500 });

  const agents = await listAgents(dbResult.val, tenantId, session.subject);
  return NextResponse.json({ agents });
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ tenantId: string }> }
): Promise<NextResponse> {
  const { tenantId } = await params;
  const session = await getSessionFromRequest(request, tenantId);
  if (!session) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });

  const dbResult = getDatabase();
  if (!dbResult.ok) return NextResponse.json({ error: 'Database unavailable' }, { status: 500 });

  const body = await request.json().catch(() => null);
  const parsed = parseAgentPayload(body);
  if ('error' in parsed) return NextResponse.json({ error: parsed.error }, { status: 400 });

  // The summary is written AFTER the response: authoring must never wait
  // on a model. The builder polls the agent until description_status
  // resolves and shows a writing indicator meanwhile.
  const result = await saveAgent(dbResult.val, tenantId, session.subject, parsed, {
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

  return NextResponse.json(
    { agentId: result.agentId, apiKeys: result.apiKeys, descriptionPending: true },
    { status: 201 }
  );
}
