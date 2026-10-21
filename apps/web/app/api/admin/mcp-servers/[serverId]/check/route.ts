/**
 * "Check this server" for an admin: run discovery now (and registration,
 * where the server allows it) through the delegate, and report what was
 * learned — without any person's token. Surfaces a wrong URL, an
 * authorization server Renkei cannot register with, or a server that turns
 * out to need no sign-in, before the first person tries to connect.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getDatabase } from '@renkei/db';
import { delegateGrants } from '@renkei/delegate-client';
import { getServer } from '@renkei/connector-mcp';
import { checkAccess, ROLE_OPERATOR } from '@/lib/access';
import { getOrigin } from '@/lib/get-origin';
import { serverSummary } from '@/lib/mcp-servers/parse';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ serverId: string }> }
): Promise<NextResponse> {
  const { serverId } = await params;
  if (!(await checkAccess([ROLE_OPERATOR]))) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const dbResult = getDatabase();
  if (!dbResult.ok) return NextResponse.json({ error: 'Database unavailable' }, { status: 500 });
  const origin = await getOrigin(request);
  if (!origin.ok) return NextResponse.json({ error: 'Config error' }, { status: 500 });

  const prepared = await delegateGrants().mcpPrepare({
    serverId,
    redirectUri: `${origin.val}/api/oauth/callback`,
    refresh: true,
  });
  const server = await getServer(dbResult.val, serverId);
  if (!server.ok || !server.val) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  if (!prepared.ok) {
    return NextResponse.json({
      ok: false,
      problem: prepared.err.type,
      message: prepared.err.message ?? prepared.err.type,
      server: serverSummary(server.val),
    });
  }
  return NextResponse.json({
    ok: true,
    open: prepared.val.authMode === 'none' && prepared.val.open,
    server: serverSummary(server.val),
  });
}
