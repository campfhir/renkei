/**
 * Disconnect the caller's grant on the fourth Atlassian app ("Renkei
 * Bitbucket"). Subject-scoped: the session decides whose grant dies,
 * never a parameter.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getDataStore } from '@renkei/db';
import { getSessionFromRequest } from '@/lib/session';
import { recordAuditEvent } from '@/lib/audit-events';
import { invalidateToolCatalogCache } from '@/lib/mcp-tools/tool-catalog';
import { ATLASSIAN_BITBUCKET } from '@renkei/provider-grants';
import { delegateGrants } from '@renkei/delegate-client';
import { logger } from '@/lib/logger';

export async function DELETE(request: NextRequest): Promise<NextResponse> {
  const session = await getSessionFromRequest(request);
  if (!session) {
    return NextResponse.json({ error: 'Not signed in' }, { status: 401 });
  }

  const [grant] = await getDataStore().providerGrants.listForSubject(session.subject, {
    provider: ATLASSIAN_BITBUCKET,
  });

  if (!grant) {
    return NextResponse.json({ message: 'Nothing to disconnect' });
  }

  // The delegate owns the grant rows (docs/delegate-key-design.md); it
  // deletes ours, and revokes at the provider where one can.
  const deleted = await delegateGrants().delete({
    provider: ATLASSIAN_BITBUCKET,
    accountId: grant.accountId,
  });
  if (!deleted.ok) {
    logger.error('Could not disconnect: {error}', {
      component: 'api/atlassian-bitbucket/grant',
      subject: session.subject,
      error: deleted.err.message ?? deleted.err.type,
    });
    return NextResponse.json({ error: 'Could not disconnect' }, { status: 500 });
  }
  recordAuditEvent({
    actorSubject: session.subject,
    action: 'connector.disconnected',
    targetKind: 'connector',
    targetLabel: ATLASSIAN_BITBUCKET,
  });
  invalidateToolCatalogCache(session.subject);
  return NextResponse.json({ message: 'Bitbucket disconnected' });
}
