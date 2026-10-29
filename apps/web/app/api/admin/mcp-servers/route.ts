/**
 * The org's list of remote MCP servers — operator-only. An admin registers
 * WHERE a server is and what it is for; who may use it, and as whom, is the
 * server's own business: each person signs in at the server from the
 * Connectors page. A client secret, when the server's authorization server
 * issued one by hand, is write-only from here.
 */

import { NextRequest, NextResponse } from 'next/server';
import { createServer, listServers } from '@renkei/connector-mcp';
import { encrypt, loadKeyring } from '@renkei/crypto';
import { checkAccess, ROLE_OPERATOR } from '@/lib/access';
import { recordAuditEvent } from '@/lib/audit-events';
import { parseServerPayload, serverSummary, slugFor } from '@/lib/mcp-servers/parse';
import { invalidateToolCatalogCache } from '@/lib/mcp-tools/tool-catalog';
import { logger } from '@/lib/logger';

export async function GET(_request: NextRequest): Promise<NextResponse> {
  if (!(await checkAccess([ROLE_OPERATOR]))) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const servers = await listServers();
  if (!servers.ok) {
    logger.error('Could not read servers: {error}', {
      component: 'api/admin/mcp-servers',
      error: servers.err.message ?? servers.err.type,
    });
    return NextResponse.json({ error: 'Could not read servers' }, { status: 500 });
  }
  return NextResponse.json({ servers: servers.val.map(serverSummary) });
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const session = await checkAccess([ROLE_OPERATOR]);
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body: unknown = await request.json().catch(() => null);
  const parsed = parseServerPayload(body);
  if ('error' in parsed) return NextResponse.json({ error: parsed.error }, { status: 400 });
  const { input } = parsed;
  const slug = slugFor(input);
  if (!slug) {
    return NextResponse.json(
      { error: 'Could not make a tool prefix from that name. Type one.' },
      { status: 400 }
    );
  }

  let encryptedClientSecret: string | null = null;
  if (input.clientSecret) {
    const key = loadKeyring('TOKEN_ENCRYPTION_KEY');
    if (!key.ok) {
      logger.error('Could not load the token encryption key: {error}', {
        component: 'api/admin/mcp-servers',
        subject: session.subject,
        error: key.err.message ?? key.err.type,
      });
      return NextResponse.json({ error: 'Server misconfigured' }, { status: 500 });
    }
    encryptedClientSecret = encrypt(input.clientSecret, key.val);
  }

  const created = await createServer({
    slug,
    name: input.name,
    url: input.url,
    transport: input.transport,
    authMode: input.authMode,
    context: input.context,
    scopes: input.scopes,
    clientId: input.clientId,
    encryptedClientSecret,
    enabled: input.enabled,
  });
  if (!created.ok) {
    if (created.err.type === 'SLUG_TAKEN') {
      return NextResponse.json(
        { error: `Another server already uses the tool prefix "${slug}".` },
        { status: 409 }
      );
    }
    logger.error('Could not create the server: {error}', {
      component: 'api/admin/mcp-servers',
      subject: session.subject,
      error: created.err.message ?? created.err.type,
    });
    return NextResponse.json({ error: 'Could not create the server' }, { status: 500 });
  }
  recordAuditEvent({
    actorSubject: session.subject,
    action: 'mcp.server.created',
    targetKind: 'mcp-server',
    targetLabel: input.name,
    details: { url: input.url, transport: input.transport, authMode: input.authMode },
  });
  invalidateToolCatalogCache();
  return NextResponse.json({ server: serverSummary(created.val) }, { status: 201 });
}
