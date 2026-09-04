/**
 * Disconnect the caller's own OnBase grant. Subject-scoped: the session
 * decides whose grant dies, never a parameter.
 *
 * Revocation at the Hyland IdP is best-effort and runs through the OnBase
 * worker (the IdP is usually unreachable from this process); deletion of
 * our copy is what matters. Nothing is indexed from OnBase in v1, so there
 * are no knowledge chunks to purge.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getDatabase } from '@renkei/db';
import { parseEncryptionKey } from '@renkei/crypto';
import { getSessionFromRequest } from '@/lib/session';
import { recordAuditEvent } from '@/lib/audit-events';
import { invalidateToolCatalogCache } from '@/lib/mcp-tools/tool-catalog';
import { deleteGrant, getGrant, ONBASE } from '@renkei/provider-grants';
import { obRevoke } from '@/lib/onbase/service-client';
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
    .select(['provider_account_id'])
    .where('tenant_id', '=', tenantId)
    .where('provider', '=', ONBASE)
    .where('subject', '=', session.subject)
    .executeTakeFirst();

  if (!grantRow) {
    return NextResponse.json({ message: 'Nothing to disconnect' });
  }
  const accountId = grantRow.provider_account_id;

  // Best-effort revocation at the IdP while we still hold the tokens. The
  // refresh token is the valuable one to kill; revoking it usually
  // invalidates the pair.
  const keyResult = parseEncryptionKey(process.env.TOKEN_ENCRYPTION_KEY || '');
  if (keyResult.ok) {
    const grant = await getGrant(ONBASE, tenantId, accountId, keyResult.val);
    if (grant.ok && grant.val) {
      const token = grant.val.refreshToken || grant.val.accessToken;
      const revoked = await obRevoke({
        tenantId,
        token,
        tokenTypeHint: grant.val.refreshToken ? 'refresh_token' : 'access_token',
      });
      if (!revoked.ok || !revoked.val.revoked) {
        logger.warn('OnBase token revocation failed; deleting the grant regardless', {
          component: 'connectors/onbase',
          tenantId,
        });
      }
    }
  }

  const deleted = await deleteGrant(ONBASE, tenantId, accountId);
  if (!deleted.ok) {
    return NextResponse.json({ error: 'Could not disconnect' }, { status: 500 });
  }
  recordAuditEvent({
    tenantId,
    actorSubject: session.subject,
    action: 'connector.disconnected',
    targetKind: 'connector',
    targetLabel: ONBASE,
  });
  invalidateToolCatalogCache(tenantId, session.subject);
  return NextResponse.json({ message: 'OnBase disconnected' });
}
