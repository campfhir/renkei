/**
 * A new user key: the browser re-wrapped the private and automation keys
 * under it and sealed it to the instances; the delegate moves everything
 * under the old key, with the old key's session delegation as proof.
 */

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { delegateClient } from '@renkei/delegate-client';
import { chatRequestContext, jsonError, readJsonBody } from '@/lib/chat/route-support';
import { recordAuditEvent } from '@/lib/audit-events';
import { automationDaysOfBody, keyMaterialOf, sealedDelegationsOf } from '@/lib/keys/status';

export async function POST(
  request: NextRequest
): Promise<Response> {
  const ready = await chatRequestContext(request);
  if (!ready.ok) return ready.response;
  const { session } = ready.context;
  const body = await readJsonBody(request);
  const wrappedPrivateKey = keyMaterialOf(body.wrappedPrivateKey);
  const wrappedAutomationKey = keyMaterialOf(body.wrappedAutomationKey);
  const sessionDelegations = sealedDelegationsOf(body.session);
  const automation = sealedDelegationsOf(body.automation ?? []);
  if (!wrappedPrivateKey || !wrappedAutomationKey || !sessionDelegations || !automation) {
    return jsonError(400, 'bad_request', 'The rotation is incomplete.');
  }
  const days = automationDaysOfBody(body.automationDays);
  const rotated = await delegateClient().rotateUserKey({
    subject: session.subject,
    sessionId: session.id,
    wrappedPrivateKey,
    wrappedAutomationKey,
    session: sessionDelegations,
    automation,
    automationUntil: days ? new Date(Date.now() + days * 24 * 60 * 60_000) : null,
  });
  if (!rotated.ok) {
    switch (rotated.err.type) {
      case 'NEEDS_DELEGATION':
      case 'NEEDS_SESSION':
        return jsonError(
          423,
          'delegation',
          'Your current key is not connected; reload and try again.'
        );
      case 'NOT_ENROLLED':
      case 'NO_USER_KEY':
        return jsonError(409, 'not_enrolled', 'Enroll first.');
      case 'BAD_DELEGATION':
      case 'KEY_MISMATCH':
        return jsonError(400, 'bad_request', 'The keys this browser sent do not fit together.');
      default:
        return jsonError(503, 'delegate', 'The key service could not be reached.');
    }
  }
  recordAuditEvent({ actorSubject: session.subject, action: 'encryption-key.rotated' });
  return NextResponse.json(rotated.val);
}
