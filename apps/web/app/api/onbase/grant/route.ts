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
import { getDataStore } from '@renkei/db';
import { getSessionFromRequest } from '@/lib/session';
import { recordAuditEvent } from '@/lib/audit-events';
import { invalidateToolCatalogCache } from '@/lib/mcp-tools/tool-catalog';
import { ONBASE } from '@renkei/provider-grants';
import { delegateGrants } from '@renkei/delegate-client';
import { logger } from '@/lib/logger';
import { who } from '@/lib/log-actor';

export async function DELETE(request: NextRequest): Promise<NextResponse> {
  const session = await getSessionFromRequest(request);
  if (!session) {
    return NextResponse.json({ error: 'Not signed in' }, { status: 401 });
  }

  const [grantRow] = await getDataStore().providerGrants.listForSubject(session.subject, {
    provider: ONBASE,
  });

  if (!grantRow) {
    return NextResponse.json({ message: 'Nothing to disconnect' });
  }
  const accountId = grantRow.accountId;

  // The delegate revokes the refresh token at the IdP (the valuable one to
  // kill; revoking it usually invalidates the pair), then deletes the grant.
  const revoked = await delegateGrants().revoke({ provider: ONBASE, accountId });
  if (!revoked.ok) {
    logger.error(
      '{actor} tried to disconnect OnBase, but the grant was not deleted ({reason}); they are still connected',
      {
        component: 'connectors/onbase',
        ...who(session),
        accountId,
        reason: revoked.err.type,
      }
    );
    return NextResponse.json({ error: 'Could not disconnect' }, { status: 500 });
  }
  if (!revoked.val.revokedAtProvider) {
    logger.warn(
      '{actor} disconnected OnBase, but the token could not be revoked at the Hyland IdP; the grant was deleted regardless',
      {
        component: 'connectors/onbase',
        ...who(session),
        accountId,
      }
    );
  }
  recordAuditEvent({
    actorSubject: session.subject,
    action: 'connector.disconnected',
    targetKind: 'connector',
    targetLabel: ONBASE,
  });
  invalidateToolCatalogCache(session.subject);
  return NextResponse.json({ message: 'OnBase disconnected' });
}
