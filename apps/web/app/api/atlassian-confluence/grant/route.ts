/**
 * Disconnect the caller's grant on the third Atlassian app ("Renkei
 * Confluence"). Subject-scoped: the session decides whose grant dies,
 * never a parameter.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getDataStore } from '@renkei/db';
import { getSessionFromRequest } from '@/lib/session';
import { recordAuditEvent } from '@/lib/audit-events';
import { invalidateToolCatalogCache } from '@/lib/mcp-tools/tool-catalog';
import { ATLASSIAN_CONFLUENCE } from '@renkei/provider-grants';
import { delegateGrants } from '@renkei/delegate-client';

export async function DELETE(request: NextRequest): Promise<NextResponse> {
  const session = await getSessionFromRequest(request);
  if (!session) {
    return NextResponse.json({ error: 'Not signed in' }, { status: 401 });
  }

  const [grant] = await getDataStore().providerGrants.listForSubject(session.subject, {
    provider: ATLASSIAN_CONFLUENCE,
  });

  if (!grant) {
    return NextResponse.json({ message: 'Nothing to disconnect' });
  }

  // The delegate owns the grant rows (docs/delegate-key-design.md); it
  // deletes ours, and revokes at the provider where one can.
  const deleted = await delegateGrants().delete({
    provider: ATLASSIAN_CONFLUENCE,
    accountId: grant.accountId,
  });
  if (!deleted.ok) {
    return NextResponse.json({ error: 'Could not disconnect' }, { status: 500 });
  }
  recordAuditEvent({
    actorSubject: session.subject,
    action: 'connector.disconnected',
    targetKind: 'connector',
    targetLabel: ATLASSIAN_CONFLUENCE,
  });
  invalidateToolCatalogCache(session.subject);
  return NextResponse.json({ message: 'Confluence disconnected' });
}
