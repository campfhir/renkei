/**
 * Disconnect the caller's own Zoom grant. Subject-scoped: the session
 * decides whose grant dies, never a parameter.
 *
 * The token is also revoked at Zoom (best-effort — deletion of our copy is
 * what matters; revocation just closes the window on the provider's side),
 * and the knowledge chunks ingested from this host's meetings are purged:
 * consent to index was the grant.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getDatabase } from '@renkei/db';
import { parseEncryptionKey } from '@renkei/crypto';
import { getSessionFromRequest } from '@/lib/session';
import { recordAuditEvent } from '@/lib/audit-events';
import { invalidateToolCatalogCache } from '@/lib/mcp-tools/tool-catalog';
import { deleteGrant, getGrant, ZOOM } from '@renkei/provider-grants';
import { deleteObjectChunks } from '@renkei/knowledge';
import { getZoomApp } from '@/lib/zoom-app';
import { getOrigin } from '@/lib/get-origin';
import { logger } from '@/lib/logger';

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ tenantId: string }> }
): Promise<NextResponse> {
  const { tenantId } = await params;
  const session = await getSessionFromRequest(request, tenantId);
  if (!session) {
    return NextResponse.json({ error: 'Not signed in' }, { status: 401 });
  }

  const dbResult = getDatabase();
  if (!dbResult.ok) {
    return NextResponse.json({ error: 'Database error' }, { status: 500 });
  }
  const db = dbResult.val;

  const grantRow = await db
    .selectFrom('provider_grants')
    .select(['provider_account_id', 'metadata'])
    .where('tenant_id', '=', tenantId)
    .where('provider', '=', ZOOM)
    .where('subject', '=', session.subject)
    .executeTakeFirst();

  if (!grantRow) {
    return NextResponse.json({ message: 'Nothing to disconnect' });
  }
  const accountId = grantRow.provider_account_id;

  // Best-effort revocation at Zoom while we still hold the token.
  const keyResult = parseEncryptionKey(process.env.TOKEN_ENCRYPTION_KEY || '');
  const originResult = await getOrigin(request);
  if (keyResult.ok && originResult.ok) {
    const [grant, app] = await Promise.all([
      getGrant(ZOOM, tenantId, accountId, keyResult.val),
      getZoomApp(tenantId, originResult.val),
    ]);
    if (grant.ok && grant.val && app) {
      try {
        const basic = Buffer.from(`${app.clientId}:${app.clientSecret}`).toString('base64');
        await fetch('https://zoom.us/oauth/revoke', {
          method: 'POST',
          headers: {
            Authorization: `Basic ${basic}`,
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body: new URLSearchParams({ token: grant.val.accessToken }).toString(),
        });
      } catch (error) {
        logger.warn('Zoom token revocation failed; deleting the grant regardless', {
          component: 'connectors/zoom',
          tenantId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  // Purge this host's chunks. The refId prefix is the host's email.
  const metadata: Record<string, unknown> =
    typeof grantRow.metadata === 'object' &&
    grantRow.metadata !== null &&
    !Array.isArray(grantRow.metadata)
      ? { ...grantRow.metadata }
      : {};
  const email = typeof metadata.email === 'string' ? metadata.email.toLowerCase() : null;
  if (email) {
    const purged = await deleteObjectChunks(tenantId, ZOOM, `${email}/`, { prefixOnly: true });
    if (!purged.ok) {
      logger.warn('Could not purge knowledge chunks on disconnect', {
        component: 'connectors/zoom',
        tenantId,
      });
    }
  }

  const deleted = await deleteGrant(ZOOM, tenantId, accountId);
  if (!deleted.ok) {
    return NextResponse.json({ error: 'Could not disconnect' }, { status: 500 });
  }
  recordAuditEvent({
    tenantId,
    actorSubject: session.subject,
    action: 'connector.disconnected',
    targetKind: 'connector',
    targetLabel: ZOOM,
  });
  invalidateToolCatalogCache(tenantId, session.subject);
  return NextResponse.json({ message: 'Zoom disconnected' });
}
