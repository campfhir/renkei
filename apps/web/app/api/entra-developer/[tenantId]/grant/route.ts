/**
 * Disconnect the caller's own Entra Developer grant. Subject-scoped: the
 * session decides whose grant dies, never a parameter. Nothing else to
 * clean up — this connector indexes nothing and holds no Graph
 * subscriptions — so, unlike the Microsoft 365 disconnect, the grant row
 * is the whole story. The Microsoft 365 grant is not touched.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getDatabase } from '@renkei/db';
import { getSessionFromRequest } from '@/lib/session';
import { recordAuditEvent } from '@/lib/audit-events';
import { invalidateToolCatalogCache } from '@/lib/mcp-tools/tool-catalog';
import { deleteGrant, ENTRA_DEVELOPER } from '@renkei/provider-grants';

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

  const grantRow = await dbResult.val
    .selectFrom('provider_grants')
    .select(['provider_account_id'])
    .where('tenant_id', '=', tenantId)
    .where('provider', '=', ENTRA_DEVELOPER)
    .where('subject', '=', session.subject)
    .executeTakeFirst();
  if (!grantRow) {
    return NextResponse.json({ message: 'Nothing to disconnect' });
  }

  const deleted = await deleteGrant(ENTRA_DEVELOPER, tenantId, grantRow.provider_account_id);
  if (!deleted.ok) {
    return NextResponse.json({ error: 'Could not disconnect' }, { status: 500 });
  }
  recordAuditEvent({
    tenantId,
    actorSubject: session.subject,
    action: 'connector.disconnected',
    targetKind: 'connector',
    targetLabel: ENTRA_DEVELOPER,
  });
  invalidateToolCatalogCache(tenantId, session.subject);
  return NextResponse.json({ message: 'Entra Developer disconnected' });
}
