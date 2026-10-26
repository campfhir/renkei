/**
 * One MCP server's registration — operator-only. Changing where a server is
 * (its URL's origin, or whether it asks for sign-in) or the client Renkei
 * presents to it ends everyone's connection to it: a token issued by one
 * server must never be sent to another.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getDatabase } from '@renkei/db';
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
import { routeLog } from '@/lib/log-context';

type Params = { params: Promise<{ serverId: string }> };

async function GETHandler(_request: NextRequest, { params }: Params): Promise<NextResponse> {
  const { serverId } = await params;
  if (!(await checkAccess([ROLE_OPERATOR]))) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const dbResult = getDatabase();
  if (!dbResult.ok) return NextResponse.json({ error: 'Database unavailable' }, { status: 500 });
  const server = await getServer(dbResult.val, serverId);
  if (!server.ok) return NextResponse.json({ error: 'Could not read the server' }, { status: 500 });
  if (!server.val) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  return NextResponse.json({ server: serverSummary(server.val) });
}

async function PATCHHandler(request: NextRequest, { params }: Params): Promise<NextResponse> {
  const { serverId } = await params;
  const session = await checkAccess([ROLE_OPERATOR]);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body: unknown = await request.json().catch(() => null);
  const parsed = parseServerPayload(body);
  if ('error' in parsed) return NextResponse.json({ error: parsed.error }, { status: 400 });
  const { input } = parsed;

  const dbResult = getDatabase();
  if (!dbResult.ok) return NextResponse.json({ error: 'Database unavailable' }, { status: 500 });
  const db = dbResult.val;
  const current = await getServer(db, serverId);
  if (!current.ok)
    return NextResponse.json({ error: 'Could not read the server' }, { status: 500 });
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
    if (!key.ok) return NextResponse.json({ error: 'Server misconfigured' }, { status: 500 });
    patch.encryptedClientSecret = encrypt(input.clientSecret, key.val);
  } else if (input.clearClientSecret) {
    patch.encryptedClientSecret = null;
  }

  const updated = await updateServer(db, serverId, patch);
  if (!updated.ok)
    return NextResponse.json({ error: 'Could not save the server' }, { status: 500 });

  if (moved || modeChanged || clientChanged || scopesChanged) {
    await db.deleteFrom('provider_grants').where('provider', '=', mcpProvider(serverId)).execute();
    await db.deleteFrom('mcp_user_tool_lists').where('server_id', '=', serverId).execute();
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

async function DELETEHandler(_request: NextRequest, { params }: Params): Promise<NextResponse> {
  const { serverId } = await params;
  const session = await checkAccess([ROLE_OPERATOR]);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const dbResult = getDatabase();
  if (!dbResult.ok) return NextResponse.json({ error: 'Database unavailable' }, { status: 500 });
  const db = dbResult.val;
  const current = await getServer(db, serverId);
  if (!current.ok)
    return NextResponse.json({ error: 'Could not read the server' }, { status: 500 });
  if (!current.val) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  // Grants are keyed by provider string, not a foreign key: remove them
  // with the server so no token outlives the registration it was issued for.
  await db.deleteFrom('provider_grants').where('provider', '=', mcpProvider(serverId)).execute();
  const deleted = await deleteServer(db, serverId);
  if (!deleted.ok)
    return NextResponse.json({ error: 'Could not delete the server' }, { status: 500 });
  recordAuditEvent({
    actorSubject: session.subject,
    action: 'mcp.server.deleted',
    targetKind: 'mcp-server',
    targetLabel: current.val.name,
  });
  invalidateToolCatalogCache();
  return NextResponse.json({ message: 'Deleted' });
}

export const GET = routeLog(GETHandler);
export const PATCH = routeLog(PATCHHandler);
export const DELETE = routeLog(DELETEHandler);
