/**
 * Disconnect the caller's own OnBase grant. Subject-scoped: the session
 * decides whose grant dies, never a parameter.
 *
 * Revocation at the Hyland IdP is best-effort and runs from the delegate
 * through the OnBase worker (the IdP is usually unreachable from this
 * process, and the tokens never are); deletion of our copy is what
 * matters. Nothing is indexed from OnBase in v1, so there are no
 * knowledge chunks to purge.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getDatabase } from '@renkei/db';
import { getSessionFromRequest } from '@/lib/session';
import { recordAuditEvent } from '@/lib/audit-events';
import { invalidateToolCatalogCache } from '@/lib/mcp-tools/tool-catalog';
import { ONBASE } from '@renkei/provider-grants';
import { delegateGrants } from '@renkei/delegate-client';
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

  // The delegate revokes the refresh token at the IdP (the valuable one to
  // kill; revoking it usually invalidates the pair), then deletes the grant.
  const revoked = await delegateGrants().revoke({ tenantId, provider: ONBASE, accountId });
  if (!revoked.ok) {
    logger.error('OnBase grant could not be deleted: {reason}', {
      component: 'connectors/onbase',
      tenantId,
      reason: revoked.err.type,
    });
    return NextResponse.json({ error: 'Could not disconnect' }, { status: 500 });
  }
  if (!revoked.val.revokedAtProvider) {
    logger.warn('OnBase token revocation failed; the grant was deleted regardless', {
      component: 'connectors/onbase',
      tenantId,
    });
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
