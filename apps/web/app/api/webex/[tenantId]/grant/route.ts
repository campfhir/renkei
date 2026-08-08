/**
 * Disconnect the caller's own WebEx user grant. Subject-scoped: the session
 * decides whose grant dies, never a parameter — one user cannot revoke
 * another's authorization from here.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getDatabase } from '@renkei/db';
import { getSessionFromRequest } from '@/lib/session';
import { deleteGrant, WEBEX_USER } from '@renkei/provider-grants';

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ tenantId: string }> }
): Promise<NextResponse> {
  const { tenantId } = await params;
  const session = await getSessionFromRequest(request, tenantId);
  if (!session) {
    return NextResponse.json({ error: 'Not signed in' }, { status: 401 });
  }

  const dbResult = getDatabase();
  if (!dbResult.ok) {
    return NextResponse.json({ error: 'Database error' }, { status: 500 });
  }

  const grant = await dbResult.val
    .selectFrom('provider_grants')
    .select('provider_account_id')
    .where('tenant_id', '=', tenantId)
    .where('provider', '=', WEBEX_USER)
    .where('subject', '=', session.subject)
    .executeTakeFirst();

  if (!grant) {
    return NextResponse.json({ message: 'Nothing to disconnect' });
  }

  const deleted = await deleteGrant(WEBEX_USER, tenantId, grant.provider_account_id);
  if (!deleted.ok) {
    return NextResponse.json({ error: 'Could not disconnect' }, { status: 500 });
  }
  return NextResponse.json({ message: 'WebEx disconnected' });
}
