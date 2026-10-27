/**
 * Disconnect the caller's grant on Renkei's GitHub App. Subject-scoped:
 * the session decides whose grant dies, never a parameter.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getDataStore } from '@renkei/db';
import { getSessionFromRequest } from '@/lib/session';
import { recordAuditEvent } from '@/lib/audit-events';
import { invalidateToolCatalogCache } from '@/lib/mcp-tools/tool-catalog';
import { GITHUB } from '@renkei/provider-grants';
import { delegateGrants } from '@renkei/delegate-client';

export async function DELETE(request: NextRequest): Promise<NextResponse> {
  const session = await getSessionFromRequest(request);
  if (!session) {
    return NextResponse.json({ error: 'Not signed in' }, { status: 401 });
  }

  const [grant] = await getDataStore().providerGrants.listForSubject(session.subject, {
    provider: GITHUB,
  });

  if (!grant) {
    return NextResponse.json({ message: 'Nothing to disconnect' });
  }

  // The delegate owns the grant rows (docs/delegate-key-design.md); it
  // deletes ours, and revokes at the provider where one can.
  const deleted = await delegateGrants().delete({
    provider: GITHUB,
    accountId: grant.accountId,
  });
  if (!deleted.ok) {
    return NextResponse.json({ error: 'Could not disconnect' }, { status: 500 });
  }
  recordAuditEvent({
    actorSubject: session.subject,
    action: 'connector.disconnected',
    targetKind: 'connector',
    targetLabel: GITHUB,
  });
  invalidateToolCatalogCache(session.subject);
  return NextResponse.json({ message: 'GitHub disconnected' });
}
