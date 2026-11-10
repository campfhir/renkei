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
import { who } from '@/lib/log-actor';

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
      logger.warn(
        '{actor} is disconnecting Zoom, but the knowledge indexed from their meetings could not be purged; it stays until a retention sweep removes it',
        {
          component: 'connectors/zoom',
          ...who(session),
          accountId,
        }
      );
    }
  }

  // Revoke at Zoom while the delegate still holds the token, then delete.
  const revoked = await delegateGrants().revoke({ provider: ZOOM, accountId });
  if (!revoked.ok) {
    logger.error(
      '{actor} asked to disconnect Zoom, but the delegate did not revoke the grant ({reason}); it is still connected',
      {
        component: 'connectors/zoom',
        ...who(session),
        accountId,
        reason: revoked.err.type,
      }
    );
    return NextResponse.json({ error: 'Could not disconnect' }, { status: 500 });
  }
  if (!revoked.val.revokedAtProvider) {
    logger.warn(
      '{actor} disconnected Zoom; the grant was deleted here, but the token could not be revoked at Zoom and will expire on its own',
      {
        component: 'connectors/zoom',
        ...who(session),
        accountId,
      }
    );
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
