/**
 * Disconnect the caller's own OnBase Administration grant. Subject-scoped:
 * the session decides whose grant dies, never a parameter. A near-duplicate
 * of ../../onbase/grant/route.ts — see lib/onbase-app.ts's
 * header for why the two connectors are not merged.
 *
 * Revocation at the Hyland IdP is best-effort and runs from the delegate
 * through the OnBase worker (the IdP is usually unreachable from this
 * process, and the tokens never are); deletion of our copy is what
 * matters. Nothing is indexed from the Administration API, so there are
 * no knowledge chunks to purge.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getDataStore } from '@renkei/db';
import { getSessionFromRequest } from '@/lib/session';
import { recordAuditEvent } from '@/lib/audit-events';
import { invalidateToolCatalogCache } from '@/lib/mcp-tools/tool-catalog';
import { ONBASE_ADMIN } from '@renkei/provider-grants';
import { delegateGrants } from '@renkei/delegate-client';
import { logger } from '@/lib/logger';

export async function DELETE(request: NextRequest): Promise<NextResponse> {
  const session = await getSessionFromRequest(request);
  if (!session) {
    return NextResponse.json({ error: 'Not signed in' }, { status: 401 });
  }

  const [grantRow] = await getDataStore().providerGrants.listForSubject(session.subject, {
    provider: ONBASE_ADMIN,
  });

  if (!grantRow) {
    return NextResponse.json({ message: 'Nothing to disconnect' });
  }
  const accountId = grantRow.accountId;

  // The delegate revokes the refresh token at the IdP (the valuable one to
  // kill; revoking it usually invalidates the pair), then deletes the grant.
  const revoked = await delegateGrants().revoke({ provider: ONBASE_ADMIN, accountId });
  if (!revoked.ok) {
    logger.error('OnBase Administration grant could not be deleted: {reason}', {
      component: 'connectors/onbase-admin',
      reason: revoked.err.type,
    });
    return NextResponse.json({ error: 'Could not disconnect' }, { status: 500 });
  }
  if (!revoked.val.revokedAtProvider) {
    logger.warn('OnBase Administration token revocation failed; the grant was deleted regardless', {
      component: 'connectors/onbase-admin',
    });
  }
  recordAuditEvent({
    actorSubject: session.subject,
    action: 'connector.disconnected',
    targetKind: 'connector',
    targetLabel: ONBASE_ADMIN,
  });
  invalidateToolCatalogCache(session.subject);
  return NextResponse.json({ message: 'OnBase Administration disconnected' });
}
