/**
 * The caller's tools on one remote MCP server. GET answers from the cache;
 * POST asks the server again now (the "Refresh tools" button) and caches
 * what it says. Per person: a server may list different tools for different
 * people, and never more than the server itself lets them have.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getServer, getToolLists } from '@renkei/connector-mcp';
import { getSessionFromRequest } from '@/lib/session';
import { refreshToolList } from '@/lib/mcp-servers/remote';

type Params = { params: Promise<{ serverId: string }> };

export async function GET(request: NextRequest, { params }: Params): Promise<NextResponse> {
  const { serverId } = await params;
  const session = await getSessionFromRequest(request);
  if (!session) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });
  const lists = await getToolLists(session.subject);
  if (!lists.ok) return NextResponse.json({ error: 'Database error' }, { status: 500 });
  const cached = lists.val.get(serverId);
  return NextResponse.json({
    tools: (cached?.tools ?? []).map((tool) => ({
      name: tool.name,
      description: tool.description,
      readOnly: tool.readOnly,
    })),
    fetchedAt: cached?.fetchedAt.toISOString() ?? null,
  });
}

export async function POST(request: NextRequest, { params }: Params): Promise<NextResponse> {
  const { serverId } = await params;
  const session = await getSessionFromRequest(request);
  if (!session) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });
  const server = await getServer(serverId);
  if (!server.ok) return NextResponse.json({ error: 'Database error' }, { status: 500 });
  if (!server.val || !server.val.enabled) {
    return NextResponse.json({ error: 'No such MCP server' }, { status: 404 });
  }
  const outcome = await refreshToolList(server.val, session.subject);
  if (!outcome.ok) {
    return NextResponse.json(
      { error: outcome.message, reason: outcome.reason },
      { status: outcome.reason === 'auth_required' ? 401 : 502 }
    );
  }
  return NextResponse.json({
    tools: outcome.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      readOnly: tool.readOnly,
    })),
    fetchedAt: new Date().toISOString(),
  });
}
