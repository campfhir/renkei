/**
 * Disconnect the caller's own Zoom grant. Subject-scoped: the session
 * decides whose grant dies, never a parameter.
 *
 * The delegate revokes the token at Zoom (best-effort — deletion of our
 * copy is what matters; revocation just closes the window on the
 * provider's side) and deletes the grant; this process never sees the
 * token. The knowledge chunks ingested from this host's meetings are
 * purged here: consent to index was the grant.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getDataStore } from '@renkei/db';
import { getSessionFromRequest } from '@/lib/session';
import { recordAuditEvent } from '@/lib/audit-events';
import { invalidateToolCatalogCache } from '@/lib/mcp-tools/tool-catalog';
import { ZOOM } from '@renkei/provider-grants';
import { delegateGrants } from '@renkei/delegate-client';
import { deleteObjectChunks } from '@renkei/knowledge';
import { logger } from '@/lib/logger';

export async function DELETE(request: NextRequest): Promise<NextResponse> {
  const session = await getSessionFromRequest(request);
  if (!session) {
    return NextResponse.json({ error: 'Not signed in' }, { status: 401 });
  }

  const [grantRow] = await getDataStore().providerGrants.listForSubject(session.subject, {
    provider: ZOOM,
  });

  if (!grantRow) {
    return NextResponse.json({ message: 'Nothing to disconnect' });
  }
  const accountId = grantRow.accountId;

  // Purge this host's chunks. The refId prefix is the host's email.
  const metadata: Record<string, unknown> =
    typeof grantRow.metadata === 'object' &&
    grantRow.metadata !== null &&
    !Array.isArray(grantRow.metadata)
      ? { ...grantRow.metadata }
      : {};
  const email = typeof metadata.email === 'string' ? metadata.email.toLowerCase() : null;
  if (email) {
    const purged = await deleteObjectChunks(ZOOM, `${email}/`, { prefixOnly: true });
    if (!purged.ok) {
      logger.warn('Could not purge knowledge chunks on disconnect', {
        component: 'connectors/zoom',
      });
    }
  }

  // Revoke at Zoom while the delegate still holds the token, then delete.
  const revoked = await delegateGrants().revoke({ provider: ZOOM, accountId });
  if (!revoked.ok) {
    logger.error('Zoom grant could not be deleted: {reason}', {
      component: 'connectors/zoom',
      reason: revoked.err.type,
    });
    return NextResponse.json({ error: 'Could not disconnect' }, { status: 500 });
  }
  if (!revoked.val.revokedAtProvider) {
    logger.warn('Zoom token revocation failed; the grant was deleted regardless', {
      component: 'connectors/zoom',
    });
  }
  recordAuditEvent({
    actorSubject: session.subject,
    action: 'connector.disconnected',
    targetKind: 'connector',
    targetLabel: ZOOM,
  });
  invalidateToolCatalogCache(session.subject);
  return NextResponse.json({ message: 'Zoom disconnected' });
}
