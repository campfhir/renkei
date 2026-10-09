/**
 * The person's automation delegation: DELETE revokes it everywhere, so
 * their agents pause until their next sign-in (renewing it is a delegate
 * call with a window, from a browser holding the key).
 */

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { delegateClient } from '@renkei/delegate-client';
import { chatRequestContext, jsonError } from '@/lib/chat/route-support';
import { recordAuditEvent } from '@/lib/audit-events';

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ tenantId: string }> }
): Promise<Response> {
  const { tenantId } = await params;
  const ready = await chatRequestContext(request, tenantId);
  if (!ready.ok) return ready.response;
  const { session } = ready.context;
  const revoked = await delegateClient().revokeAutomation(tenantId, session.subject);
  if (!revoked.ok) return jsonError(503, 'delegate', 'The key service could not be reached.');
  recordAuditEvent({
    tenantId,
    actorSubject: session.subject,
    action: 'encryption-key.automation-revoked',
  });
  return NextResponse.json({ revoked: revoked.val });
}
