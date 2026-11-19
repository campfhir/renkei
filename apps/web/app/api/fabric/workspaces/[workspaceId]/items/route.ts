/** The items in one of the person's Fabric workspaces, for the Fabric page. */

import { NextRequest, NextResponse } from 'next/server';
import { getSessionFromRequest } from '@/lib/session';
import { fabricAccessFor } from '@/lib/fabric/server';
import { fabricList, isGuid } from '@/lib/mcp-tools/fabric/client';
import { itemOf } from '@/lib/mcp-tools/fabric/resolve';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ workspaceId: string }> }
): Promise<NextResponse> {
  const { workspaceId } = await params;
  if (!isGuid(workspaceId)) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  const session = await getSessionFromRequest(request);
  if (!session) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });
  const access = await fabricAccessFor(session.subject);
  if (typeof access === 'string') return NextResponse.json({ error: access }, { status: 409 });
  const listed = await fabricList(
    { subject: session.subject },
    access,
    `/workspaces/${workspaceId}/items`
  );
  if (!listed.ok) return NextResponse.json({ error: listed.error }, { status: 502 });
  return NextResponse.json({ items: listed.values.map(itemOf), truncated: listed.truncated });
}
