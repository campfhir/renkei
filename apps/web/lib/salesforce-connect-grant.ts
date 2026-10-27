/**
 * Disconnect the caller from one Salesforce connector (org), of either type. Subject-scoped:
 * the session decides whose connection goes, never a parameter — the
 * connector key only says which of their connections. The delegate revokes
 * the refresh token at that org before deleting its copy, so a disconnected
 * connection is gone in Salesforce too. Works for a connector an admin has
 * switched off or removed as well, so nobody is left holding a grant.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getDatabase } from '@renkei/db';
import { getSessionFromRequest } from '@/lib/session';
import { recordAuditEvent } from '@/lib/audit-events';
import { invalidateToolCatalogCache } from '@/lib/mcp-tools/tool-catalog';
import { delegateGrants } from '@renkei/delegate-client';
import { listSalesforceConnectors } from '@/lib/salesforce-app';
import { listSalesforceConnections } from '@/lib/salesforce-grants';
import type { SalesforceKind } from '@/lib/salesforce-kinds';

export async function disconnectSalesforce(
  kind: SalesforceKind,
  request: NextRequest,
  { params }: { params: Promise<{ connector: string }> }
): Promise<NextResponse> {
  const { connector } = await params;
  const session = await getSessionFromRequest(request);
  if (!session) {
    return NextResponse.json({ error: 'Not signed in' }, { status: 401 });
  }

  const dbResult = getDatabase();
  if (!dbResult.ok) {
    return NextResponse.json({ error: 'Database error' }, { status: 500 });
  }

  const connections = await listSalesforceConnections(
    session.subject,
    await listSalesforceConnectors(kind),
    kind.provider
  );
  // `-` names connections to an org that is no longer a connector (removed
  // by an admin): a person can still revoke them. No key can be `-`.
  const wanted = connector === '-' ? null : connector;
  const mine = connections.filter((connection) => connection.connector === wanted);
  if (mine.length === 0) {
    return NextResponse.json({ message: 'Nothing to disconnect' });
  }

  for (const connection of mine) {
    const revoked = await delegateGrants().revoke({
      provider: kind.provider,
      accountId: connection.accountId,
    });
    if (!revoked.ok) {
      return NextResponse.json({ error: 'Could not disconnect' }, { status: 500 });
    }
  }
  recordAuditEvent({
    actorSubject: session.subject,
    action: 'connector.disconnected',
    targetKind: 'connector',
    targetLabel: `${kind.provider}:${connector}`,
  });
  invalidateToolCatalogCache(session.subject);
  return NextResponse.json({ message: `${kind.label} disconnected` });
}
