/**
 * Disconnect the caller's own connection to one remote MCP server.
 * Subject-scoped: the session decides whose grant dies, never a parameter.
 * The delegate revokes the token at the server's authorization server where
 * it offers revocation (best effort) and deletes the grant; the cached tool
 * list goes with it.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getDataStore } from '@renkei/db';
import { wrapAsync } from '@campfhir/safe-functions/helpers';
import { delegateGrants } from '@renkei/delegate-client';
import { clearToolList, getServer, mcpProvider } from '@renkei/connector-mcp';
import { getSessionFromRequest } from '@/lib/session';
import { recordAuditEvent } from '@/lib/audit-events';
import { invalidateToolCatalogCache } from '@/lib/mcp-tools/tool-catalog';
import { stopWatching } from '@/lib/mcp-servers/watch';
import { logger } from '@/lib/logger';

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ serverId: string }> }
): Promise<NextResponse> {
  const { serverId } = await params;
  const session = await getSessionFromRequest(request);
  if (!session) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });
  const provider = mcpProvider(serverId);
  const grants = await wrapAsync(
    () => getDataStore().providerGrants.listForSubject(session.subject, { provider }),
    'DB_ERROR' as const
  );
  if (!grants.ok) return NextResponse.json({ error: 'Database error' }, { status: 500 });
  const grantRow = grants.val[0];
  if (!grantRow) return NextResponse.json({ message: 'Nothing to disconnect' });

  const revoked = await delegateGrants().revoke({
    provider,
    accountId: grantRow.accountId,
  });
  if (!revoked.ok) {
    logger.error('MCP grant could not be deleted: {reason}', {
      component: 'mcp-servers',
      reason: revoked.err.type,
    });
    return NextResponse.json({ error: 'Could not disconnect' }, { status: 500 });
  }
  stopWatching(serverId, session.subject);
  await clearToolList(serverId, session.subject);
  const server = await getServer(serverId);
  recordAuditEvent({
    actorSubject: session.subject,
    action: 'connector.disconnected',
    targetKind: 'connector',
    targetLabel: server.ok && server.val ? `mcp-${server.val.slug}` : provider,
  });
  invalidateToolCatalogCache(session.subject);
  return NextResponse.json({ message: 'Disconnected' });
}
