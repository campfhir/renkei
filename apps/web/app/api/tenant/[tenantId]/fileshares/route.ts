/**
 * The caller's granted file shares — the REST twin of
 * fileshare_list_shares, feeding the files browser and the connectors
 * card. Same store helper, same rule: no grant row, no share, and the
 * response never distinguishes "does not exist" from "not yours".
 */

import { NextRequest, NextResponse } from 'next/server';
import { getDatabase } from '@renkei/db';
import { listGrantedShares } from '@renkei/connector-fileshares';
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

  const granted = await listGrantedShares(dbResult.val, tenantId, session.subject);
  if (!granted.ok) {
    return NextResponse.json({ error: 'Could not read share access' }, { status: 500 });
  }

  return NextResponse.json({
    shares: granted.val.map((entry) => ({
      id: entry.share.id,
      name: entry.share.name,
      protocol: entry.share.protocol,
      host: entry.share.host,
      shareName: entry.share.shareName,
      defaultAccess: entry.grant.defaultAccess,
      hasRules: entry.hasRules,
      hasCredentials: entry.share.hasCredentials,
    })),
  });
}
