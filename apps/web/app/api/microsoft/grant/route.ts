/**
 * Disconnect the caller's own Microsoft grant. Subject-scoped: the session
 * decides whose grant dies, never a parameter.
 *
 * Disconnect is also a data-retention event: the grant's Graph
 * subscriptions are deleted on the grant's own fetcher (best-effort — a
 * grant the delegate can no longer refresh just means they lapse on their
 * own within days, and the webhook route drops their deliveries as
 * unknown meanwhile), the subscription rows go, and
 * every knowledge chunk indexed from this mailbox is purged. Consent to
 * index was the grant; revoking one revokes the other.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getDataStore } from '@renkei/db';
import { getSessionFromRequest } from '@/lib/session';
import { recordAuditEvent } from '@/lib/audit-events';
import { invalidateToolCatalogCache } from '@/lib/mcp-tools/tool-catalog';
import { MICROSOFT } from '@renkei/provider-grants';
import { delegateGrants, grantFetch } from '@renkei/delegate-client';
import { deleteGraphSubscription } from '@renkei/connector-microsoft';
import { deleteObjectChunks } from '@renkei/knowledge';
import { logger } from '@/lib/logger';

export async function DELETE(request: NextRequest): Promise<NextResponse> {
  const session = await getSessionFromRequest(request);
  if (!session) {
    return NextResponse.json({ error: 'Not signed in' }, { status: 401 });
  }

  const [grantRow] = await getDataStore().providerGrants.listForSubject(session.subject, {
    provider: MICROSOFT,
  });

  if (!grantRow) {
    return NextResponse.json({ message: 'Nothing to disconnect' });
  }
  const accountId = grantRow.accountId;

  // Best-effort provider-side cleanup while the grant still exists: each
  // subscription is deleted through the grant's own fetcher, so the token
  // never passes through this process.
  const subscriptions = await getDataStore().webhookSubscriptions.listForAccount(
    MICROSOFT,
    accountId
  );
  const auth = grantFetch({ provider: MICROSOFT, accountId });
  for (const row of subscriptions) {
    if (!row.subscriptionId) continue;
    const deleted = await deleteGraphSubscription(auth, row.subscriptionId);
    if (!deleted.ok) {
      logger.warn('Could not delete Graph subscription on disconnect; it will lapse', {
        component: 'connectors/microsoft',
        subscriptionId: row.subscriptionId,
      });
    }
  }

  await getDataStore().webhookSubscriptions.deleteForAccount(MICROSOFT, accountId);

  // Purge this mailbox's chunks. The refId prefix is the owner's upn.
  const metadata: Record<string, unknown> =
    typeof grantRow.metadata === 'object' &&
    grantRow.metadata !== null &&
    !Array.isArray(grantRow.metadata)
      ? { ...grantRow.metadata }
      : {};
  const upn = typeof metadata.upn === 'string' ? metadata.upn.toLowerCase() : null;
  if (upn) {
    const purged = await deleteObjectChunks(MICROSOFT, `${upn}/`, { prefixOnly: true });
    if (!purged.ok) {
      logger.warn('Could not purge knowledge chunks on disconnect', {
        component: 'connectors/microsoft',
      });
    }
  }

  const deleted = await delegateGrants().delete({ provider: MICROSOFT, accountId });
  if (!deleted.ok) {
    logger.error('Could not disconnect: {error}', {
      component: 'connectors/microsoft',
      subject: session.subject,
      error: deleted.err.message ?? deleted.err.type,
    });
    return NextResponse.json({ error: 'Could not disconnect' }, { status: 500 });
  }
  recordAuditEvent({
    actorSubject: session.subject,
    action: 'connector.disconnected',
    targetKind: 'connector',
    targetLabel: MICROSOFT,
  });
  invalidateToolCatalogCache(session.subject);
  return NextResponse.json({ message: 'Microsoft disconnected' });
}
