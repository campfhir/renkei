/**
 * The signed-in person's Fabric workspaces, for the Fabric page: a live
 * call on their own grant, nothing stored.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSessionFromRequest } from '@/lib/session';
import { fabricAccessFor } from '@/lib/fabric/server';
import { fabricList } from '@/lib/mcp-tools/fabric/client';
import { workspaceOf } from '@/lib/mcp-tools/fabric/resolve';

export async function GET(request: NextRequest): Promise<NextResponse> {
  const session = await getSessionFromRequest(request);
  if (!session) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });
  const access = await fabricAccessFor(session.subject);
  if (typeof access === 'string') return NextResponse.json({ error: access }, { status: 409 });
  const listed = await fabricList({ subject: session.subject }, access, '/workspaces');
  if (!listed.ok) return NextResponse.json({ error: listed.error }, { status: 502 });
  return NextResponse.json({
    workspaces: listed.values
      .map(workspaceOf)
      .sort((a, b) => a.displayName.localeCompare(b.displayName)),
    truncated: listed.truncated,
  });
}
