/**
 * Fresh delegations from an enrolled browser: on sign-in, after a delegate
 * restart, or to renew the automation window. The body carries sealed
 * boxes only; the delegate checks the one sealed to itself opens to the
 * key the person's wrappings are under.
 */

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { delegateClient } from '@renkei/delegate-client';
import { chatRequestContext, jsonError, readJsonBody } from '@/lib/chat/route-support';
import { automationDaysOfBody, sealedDelegationsOf, setAutomationDays } from '@/lib/keys/status';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ tenantId: string }> }
): Promise<Response> {
  const { tenantId } = await params;
  const ready = await chatRequestContext(request, tenantId);
  if (!ready.ok) return ready.response;
  const { db, session } = ready.context;
  const body = await readJsonBody(request);
  const sessionDelegations = sealedDelegationsOf(body.session ?? []);
  const automation = sealedDelegationsOf(body.automation ?? []);
  if (!sessionDelegations || !automation)
    return jsonError(400, 'bad_request', 'Malformed delegations.');
  const days = automationDaysOfBody(body.automationDays);
  const delegated = await delegateClient().delegate({
    tenantId,
    subject: session.subject,
    sessionId: session.id,
    session: sessionDelegations,
    automation,
    automationUntil: days ? new Date(Date.now() + days * 24 * 60 * 60_000) : null,
  });
  if (!delegated.ok) {
    switch (delegated.err.type) {
      case 'NOT_ENROLLED':
      case 'NO_USER_KEY':
        return jsonError(409, 'not_enrolled', 'Enroll first.');
      case 'BAD_DELEGATION':
        return jsonError(400, 'bad_request', 'The delegation does not open to your key.');
      default:
        return jsonError(503, 'delegate', 'The key service could not be reached.');
    }
  }
  if (days) await setAutomationDays(db, tenantId, session.subject, days);
  return NextResponse.json({ ok: true });
}
