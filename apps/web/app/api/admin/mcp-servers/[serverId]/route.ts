/**
 * One MCP server's registration — operator-only. Changing where a server is
 * (its URL's origin, or whether it asks for sign-in) or the client Renkei
 * presents to it ends everyone's connection to it: a token issued by one
 * server must never be sent to another.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getDataStore } from '@renkei/db';
import {
  deleteServer,
  getServer,
  mcpProvider,
  sameOrigin,
  updateServer,
  type ServerPatch,
} from '@renkei/connector-mcp';
import { encrypt, loadKeyring } from '@renkei/crypto';
import { checkAccess, ROLE_OPERATOR } from '@/lib/access';
import { recordAuditEvent } from '@/lib/audit-events';
import { parseServerPayload, serverSummary } from '@/lib/mcp-servers/parse';
import { invalidateToolCatalogCache } from '@/lib/mcp-tools/tool-catalog';
import { logger } from '@/lib/logger';

type Params = { params: Promise<{ serverId: string }> };

export async function GET(_request: NextRequest, { params }: Params): Promise<NextResponse> {
  const { serverId } = await params;
  if (!(await checkAccess([ROLE_OPERATOR]))) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const server = await getServer(serverId);
  if (!server.ok) {
    logger.error('Could not read the server: {error}', {
      component: 'api/admin/mcp-servers',
      serverId,
      error: server.err.message ?? server.err.type,
    });
    return NextResponse.json({ error: 'Could not read the server' }, { status: 500 });
  }
  if (!server.val) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  return NextResponse.json({ server: serverSummary(server.val) });
}

export async function PATCH(request: NextRequest, { params }: Params): Promise<NextResponse> {
  const { serverId } = await params;
  const session = await checkAccess([ROLE_OPERATOR]);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body: unknown = await request.json().catch(() => null);
  const parsed = parseServerPayload(body);
  if ('error' in parsed) return NextResponse.json({ error: parsed.error }, { status: 400 });
  const { input } = parsed;

  const current = await getServer(serverId);
  if (!current.ok) {
    logger.error('Could not read the server: {error}', {
      component: 'api/admin/mcp-servers',
      subject: session.subject,
      serverId,
      error: current.err.message ?? current.err.type,
    });
    return NextResponse.json({ error: 'Could not read the server' }, { status: 500 });
  }
  if (!current.val) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  const before = current.val;

  const patch: ServerPatch = {
    name: input.name,
    url: input.url,
    transport: input.transport,
    authMode: input.authMode,
    context: input.context,
    scopes: input.scopes,
    enabled: input.enabled,
  };

  // What invalidates a connection: a different server, no longer asking for
  // sign-in (or starting to), or a different client at the same server.
  const moved = !sameOrigin(before.url, input.url);
  const modeChanged = before.authMode !== input.authMode;
  const clientChanged =
    (input.clientId !== null && input.clientId !== before.clientId) ||
    input.clientSecret !== null ||
    input.clearClientSecret;
  const scopesChanged = (before.scopes ?? null) !== input.scopes;

  if (moved || modeChanged) {
    // New place, new registration: forget what was learned about the old one.
    // The form echoes the old registration's client id back, so only a
    // DIFFERENT one is the admin's new choice.
    patch.oauth = null;
    patch.clientId = input.clientId !== before.clientId ? input.clientId : null;
    patch.encryptedClientSecret = null;
  }
  if (!moved && !modeChanged) {
    if (input.clientId !== null || input.clientSecret !== null || input.clearClientSecret) {
      patch.clientId = input.clientId;
    }
  }
  if (input.clientSecret) {
    const key = loadKeyring('TOKEN_ENCRYPTION_KEY');
    if (!key.ok) {
      logger.error('Could not load the token encryption key: {error}', {
        component: 'api/admin/mcp-servers',
        subject: session.subject,
        serverId,
        error: key.err.message ?? key.err.type,
      });
      return NextResponse.json({ error: 'Server misconfigured' }, { status: 500 });
    }
    patch.encryptedClientSecret = encrypt(input.clientSecret, key.val);
  } else if (input.clearClientSecret) {
    patch.encryptedClientSecret = null;
  }

  const updated = await updateServer(serverId, patch);
  if (!updated.ok) {
    logger.error('Could not save the server: {error}', {
      component: 'api/admin/mcp-servers',
      subject: session.subject,
      serverId,
      error: updated.err.message ?? updated.err.type,
    });
    return NextResponse.json({ error: 'Could not save the server' }, { status: 500 });
  }

  if (moved || modeChanged || clientChanged || scopesChanged) {
    const store = getDataStore();
    await store.providerGrants.deleteForProvider(mcpProvider(serverId));
    await store.mcpServers.clearToolListsForServer(serverId);
  }
  recordAuditEvent({
    actorSubject: session.subject,
    action: 'mcp.server.updated',
    targetKind: 'mcp-server',
    targetLabel: input.name,
    details: { connectionsEnded: moved || modeChanged || clientChanged || scopesChanged },
  });
  invalidateToolCatalogCache();
  return NextResponse.json({ server: serverSummary(updated.val) });
}

export async function DELETE(_request: NextRequest, { params }: Params): Promise<NextResponse> {
  const { serverId } = await params;
  const session = await checkAccess([ROLE_OPERATOR]);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const current = await getServer(serverId);
  if (!current.ok) {
    logger.error('Could not read the server: {error}', {
      component: 'api/admin/mcp-servers',
      subject: session.subject,
      serverId,
      error: current.err.message ?? current.err.type,
    });
    return NextResponse.json({ error: 'Could not read the server' }, { status: 500 });
  }
  if (!current.val) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  // Grants are keyed by provider string, not a foreign key: remove them
  // with the server so no token outlives the registration it was issued for.
  await getDataStore().providerGrants.deleteForProvider(mcpProvider(serverId));
  const deleted = await deleteServer(serverId);
  if (!deleted.ok) {
    logger.error('Could not delete the server: {error}', {
      component: 'api/admin/mcp-servers',
      subject: session.subject,
      serverId,
      error: deleted.err.message ?? deleted.err.type,
    });
    return NextResponse.json({ error: 'Could not delete the server' }, { status: 500 });
  }
  recordAuditEvent({
    actorSubject: session.subject,
    action: 'mcp.server.deleted',
    targetKind: 'mcp-server',
    targetLabel: current.val.name,
  });
  invalidateToolCatalogCache();
  return NextResponse.json({ message: 'Deleted' });
}
