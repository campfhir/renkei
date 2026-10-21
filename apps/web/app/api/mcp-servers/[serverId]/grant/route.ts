/**
 * Disconnect the caller's own connection to one remote MCP server.
 * Subject-scoped: the session decides whose grant dies, never a parameter.
 * The delegate revokes the token at the server's authorization server where
 * it offers revocation (best effort) and deletes the grant; the cached tool
 * list goes with it.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getDatabase } from '@renkei/db';
import { delegateGrants } from '@renkei/delegate-client';
import { clearToolList, getServer, mcpProvider } from '@renkei/connector-mcp';
import { getSessionFromRequest } from '@/lib/session';
import { recordAuditEvent } from '@/lib/audit-events';
import { invalidateToolCatalogCache } from '@/lib/mcp-tools/tool-catalog';
import { logger } from '@/lib/logger';

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ serverId: string }> }
): Promise<NextResponse> {
  const { serverId } = await params;
  const session = await getSessionFromRequest(request);
  if (!session) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });
  const dbResult = getDatabase();
  if (!dbResult.ok) return NextResponse.json({ error: 'Database error' }, { status: 500 });
  const db = dbResult.val;

  const provider = mcpProvider(serverId);
  const grantRow = await db
    .selectFrom('provider_grants')
    .select('provider_account_id')
    .where('provider', '=', provider)
    .where('subject', '=', session.subject)
    .executeTakeFirst();
  if (!grantRow) return NextResponse.json({ message: 'Nothing to disconnect' });

  const revoked = await delegateGrants().revoke({
    provider,
    accountId: grantRow.provider_account_id,
  });
  if (!revoked.ok) {
    logger.error('MCP grant could not be deleted: {reason}', {
      component: 'mcp-servers',
      reason: revoked.err.type,
    });
    return NextResponse.json({ error: 'Could not disconnect' }, { status: 500 });
  }
  await clearToolList(db, serverId, session.subject);
  const server = await getServer(db, serverId);
  recordAuditEvent({
    actorSubject: session.subject,
    action: 'connector.disconnected',
    targetKind: 'connector',
    targetLabel: server.ok && server.val ? `mcp-${server.val.slug}` : provider,
  });
  invalidateToolCatalogCache(session.subject);
  return NextResponse.json({ message: 'Disconnected' });
}
