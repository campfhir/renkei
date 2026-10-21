/**
 * Disconnect the caller's Salesforce grant. Subject-scoped: the session
 * decides whose grant goes, never a parameter. The delegate revokes the
 * refresh token at the org before deleting its copy, so a disconnected
 * connection is gone in Salesforce too.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getDatabase } from '@renkei/db';
import { getSessionFromRequest } from '@/lib/session';
import { recordAuditEvent } from '@/lib/audit-events';
import { invalidateToolCatalogCache } from '@/lib/mcp-tools/tool-catalog';
import { SALESFORCE } from '@renkei/provider-grants';
import { delegateGrants } from '@renkei/delegate-client';

export async function DELETE(request: NextRequest): Promise<NextResponse> {
  const session = await getSessionFromRequest(request);
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
    .where('provider', '=', SALESFORCE)
    .where('subject', '=', session.subject)
    .executeTakeFirst();

  if (!grant) {
    return NextResponse.json({ message: 'Nothing to disconnect' });
  }

  const revoked = await delegateGrants().revoke({
    provider: SALESFORCE,
    accountId: grant.provider_account_id,
  });
  if (!revoked.ok) {
    return NextResponse.json({ error: 'Could not disconnect' }, { status: 500 });
  }
  recordAuditEvent({
    actorSubject: session.subject,
    action: 'connector.disconnected',
    targetKind: 'connector',
    targetLabel: SALESFORCE,
  });
  invalidateToolCatalogCache(session.subject);
  return NextResponse.json({ message: 'Salesforce disconnected' });
}
