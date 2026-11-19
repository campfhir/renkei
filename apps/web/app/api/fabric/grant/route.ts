/**
 * Disconnect the caller's own Microsoft Fabric grant. Subject-scoped: the
 * session decides whose grant dies, never a parameter. Nothing is indexed
 * and nothing subscribed, so the grant row is the whole story; a
 * definition fetch still running ends failed at its next poll, when the
 * delegate has no grant to send it with. Microsoft 365 and Entra Developer
 * are not touched.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getDataStore } from '@renkei/db';
import { getSessionFromRequest } from '@/lib/session';
import { recordAuditEvent } from '@/lib/audit-events';
import { invalidateToolCatalogCache } from '@/lib/mcp-tools/tool-catalog';
import { FABRIC } from '@renkei/provider-grants';
import { delegateGrants } from '@renkei/delegate-client';
import { logger } from '@/lib/logger';
import { who } from '@/lib/log-actor';

export async function DELETE(request: NextRequest): Promise<NextResponse> {
  const session = await getSessionFromRequest(request);
  if (!session) {
    return NextResponse.json({ error: 'Not signed in' }, { status: 401 });
  }

  const [grantRow] = await getDataStore().providerGrants.listForSubject(session.subject, {
    provider: FABRIC,
  });
  if (!grantRow) {
    return NextResponse.json({ message: 'Nothing to disconnect' });
  }

  const deleted = await delegateGrants().delete({
    provider: FABRIC,
    accountId: grantRow.accountId,
  });
  if (!deleted.ok) {
    logger.error(
      '{actor} asked to disconnect Microsoft Fabric, but the delegate did not delete the grant; it is still connected: {error}',
      {
        component: 'api/fabric/grant',
        ...who(session),
        accountId: grantRow.accountId,
        error: deleted.err.message ?? deleted.err.type,
      }
    );
    return NextResponse.json({ error: 'Could not disconnect' }, { status: 500 });
  }
  recordAuditEvent({
    actorSubject: session.subject,
    action: 'connector.disconnected',
    targetKind: 'connector',
    targetLabel: FABRIC,
  });
  invalidateToolCatalogCache(session.subject);
  return NextResponse.json({ message: 'Microsoft Fabric disconnected' });
}
