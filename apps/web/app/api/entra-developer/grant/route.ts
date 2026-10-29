/**
 * Disconnect the caller's own Entra Developer grant. Subject-scoped: the
 * session decides whose grant dies, never a parameter. Nothing else to
 * clean up — this connector indexes nothing and holds no Graph
 * subscriptions — so, unlike the Microsoft 365 disconnect, the grant row
 * is the whole story. The Microsoft 365 grant is not touched.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getDataStore } from '@renkei/db';
import { getSessionFromRequest } from '@/lib/session';
import { recordAuditEvent } from '@/lib/audit-events';
import { invalidateToolCatalogCache } from '@/lib/mcp-tools/tool-catalog';
import { ENTRA_DEVELOPER } from '@renkei/provider-grants';
import { delegateGrants } from '@renkei/delegate-client';
import { logger } from '@/lib/logger';

export async function DELETE(request: NextRequest): Promise<NextResponse> {
  const session = await getSessionFromRequest(request);
  if (!session) {
    return NextResponse.json({ error: 'Not signed in' }, { status: 401 });
  }

  const [grantRow] = await getDataStore().providerGrants.listForSubject(session.subject, {
    provider: ENTRA_DEVELOPER,
  });
  if (!grantRow) {
    return NextResponse.json({ message: 'Nothing to disconnect' });
  }

  const deleted = await delegateGrants().delete({
    provider: ENTRA_DEVELOPER,
    accountId: grantRow.accountId,
  });
  if (!deleted.ok) {
    logger.error('Could not disconnect: {error}', {
      component: 'api/entra-developer/grant',
      subject: session.subject,
      error: deleted.err.message ?? deleted.err.type,
    });
    return NextResponse.json({ error: 'Could not disconnect' }, { status: 500 });
  }
  recordAuditEvent({
    actorSubject: session.subject,
    action: 'connector.disconnected',
    targetKind: 'connector',
    targetLabel: ENTRA_DEVELOPER,
  });
  invalidateToolCatalogCache(session.subject);
  return NextResponse.json({ message: 'Entra Developer disconnected' });
}
