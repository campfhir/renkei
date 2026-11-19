/** A lakehouse's tables (names and formats, no rows), for the Fabric page. */

import { NextRequest, NextResponse } from 'next/server';
import { getSessionFromRequest } from '@/lib/session';
import { fabricAccessFor } from '@/lib/fabric/server';
import { fabricList, isGuid, str } from '@/lib/mcp-tools/fabric/client';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ workspaceId: string; lakehouseId: string }> }
): Promise<NextResponse> {
  const { workspaceId, lakehouseId } = await params;
  if (!isGuid(workspaceId) || !isGuid(lakehouseId)) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }
  const session = await getSessionFromRequest(request);
  if (!session) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });
  const access = await fabricAccessFor(session.subject);
  if (typeof access === 'string') return NextResponse.json({ error: access }, { status: 409 });
  const listed = await fabricList(
    { subject: session.subject },
    access,
    `/workspaces/${workspaceId}/lakehouses/${lakehouseId}/tables?maxResults=100`
  );
  if (!listed.ok) return NextResponse.json({ error: listed.error }, { status: 502 });
  return NextResponse.json({
    tables: listed.values.map((table) => ({
      name: str(table.name),
      type: str(table.type),
      format: str(table.format),
      location: str(table.location),
    })),
    truncated: listed.truncated,
  });
}
