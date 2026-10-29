/**
 * Disconnect the caller's own WebEx user grant. Subject-scoped: the session
 * decides whose grant dies, never a parameter — one user cannot revoke
 * another's authorization from here.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getDataStore } from '@renkei/db';
import { getSessionFromRequest } from '@/lib/session';
import { recordAuditEvent } from '@/lib/audit-events';
import { invalidateToolCatalogCache } from '@/lib/mcp-tools/tool-catalog';
import { WEBEX_USER } from '@renkei/provider-grants';
import { delegateGrants } from '@renkei/delegate-client';

export async function DELETE(request: NextRequest): Promise<NextResponse> {
  const session = await getSessionFromRequest(request);
  if (!session) {
    return NextResponse.json({ error: 'Not signed in' }, { status: 401 });
  }

  const [grant] = await getDataStore().providerGrants.listForSubject(session.subject, {
    provider: WEBEX_USER,
  });

  if (!grant) {
    return NextResponse.json({ message: 'Nothing to disconnect' });
  }

  // WebEx offers no revocation endpoint for a user token; the delegate
  // deletes the grant and the token expires on its own.
  const deleted = await delegateGrants().delete({
    provider: WEBEX_USER,
    accountId: grant.accountId,
  });
  if (!deleted.ok) {
    return NextResponse.json({ error: 'Could not disconnect' }, { status: 500 });
  }
  recordAuditEvent({
    actorSubject: session.subject,
    action: 'connector.disconnected',
    targetKind: 'connector',
    targetLabel: WEBEX_USER,
  });
  invalidateToolCatalogCache(session.subject);
  return NextResponse.json({ message: 'WebEx disconnected' });
}
