/**
 * The org's file shares as this caller sees them — the REST twin of what
 * the connectors card and files browser render. Every enabled share is
 * listed (discovery is not the gate in this model — credentials are),
 * marked with whether the caller has connected it and, where they have,
 * the account name and their LLM-exposure choice.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getDatabase } from '@renkei/db';
import { listSharesWithConnection } from '@renkei/connector-fileshares';
import { getSessionFromRequest } from '@/lib/session';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ tenantId: string }> }
): Promise<NextResponse> {
  const { tenantId } = await params;
  const session = await getSessionFromRequest(request, tenantId);
  if (!session) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });

  const dbResult = getDatabase();
  if (!dbResult.ok) return NextResponse.json({ error: 'Database unavailable' }, { status: 500 });

  const shares = await listSharesWithConnection(dbResult.val, tenantId, session.subject);
  if (!shares.ok) {
    return NextResponse.json({ error: 'Could not read the shares' }, { status: 500 });
  }

  return NextResponse.json({
    shares: shares.val.map((entry) => ({
      id: entry.share.id,
      name: entry.share.name,
      protocol: entry.share.protocol,
      host: entry.share.host,
      shareName: entry.share.shareName,
      connection: entry.connection
        ? {
            username: entry.connection.username,
            toolAccess: entry.connection.toolAccess,
            allowDelete: entry.connection.allowDelete,
          }
        : null,
    })),
  });
}
