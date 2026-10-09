/**
 * Fresh delegations from an enrolled browser: on sign-in, after a delegate
 * restart, or to renew the automation window. The body carries sealed
 * boxes only; the delegate checks the one sealed to itself opens to the
 * key the person's wrappings are under, and lets the automation rows be
 * replaced only alongside that proof — a session cookie on its own cannot
 * sideline or redirect a person's agents. An empty session list is a
 * refusal unless `revokeSession` says dropping this session's rows is the
 * point.
 */

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { delegateClient } from '@renkei/delegate-client';
import { agentJobsQueue } from '@renkei/queue';
import { chatRequestContext, jsonError, readJsonBody } from '@/lib/chat/route-support';
import { resumeRunsNeedingSignIn } from '@/lib/agents/needs-sign-in';
import { recordAuditEvent } from '@/lib/audit-events';
import { automationDaysOfBody, sealedDelegationsOf, setAutomationDays } from '@/lib/keys/status';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ }> }
): Promise<Response> {
  const ready = await chatRequestContext(request);
  if (!ready.ok) return ready.response;
  const { db, session } = ready.context;
  const body = await readJsonBody(request);
  const sessionDelegations = sealedDelegationsOf(body.session ?? []);
  const automation = sealedDelegationsOf(body.automation ?? []);
  if (!sessionDelegations || !automation)
    return jsonError(400, 'bad_request', 'Malformed delegations.');
  const days = automationDaysOfBody(body.automationDays);
  const delegated = await delegateClient().delegate({
    subject: session.subject,
    sessionId: session.id,
    session: sessionDelegations,
    automation,
    automationUntil: days ? new Date(Date.now() + days * 24 * 60 * 60_000) : null,
    revokeSession: body.revokeSession === true,
  });
  if (!delegated.ok) {
    switch (delegated.err.type) {
      case 'NOT_ENROLLED':
      case 'NO_USER_KEY':
        return jsonError(409, 'not_enrolled', 'Enroll first.');
      case 'BAD_DELEGATION':
        return jsonError(400, 'bad_request', 'The delegation does not open to your key.');
      case 'NEEDS_SESSION':
        return jsonError(
          423,
          'delegation',
          'Renewing your agents needs your key on this device; reload and try again.'
        );
      case 'SESSION_MISMATCH':
        return jsonError(403, 'session', 'This session cannot hold your key.');
      default:
        return jsonError(503, 'delegate', 'The key service could not be reached.');
    }
  }
  if (automation.length > 0) {
    recordAuditEvent({
      actorSubject: session.subject,
      action: 'encryption-key.automation-renewed',
      details: { instances: automation.length, days: days ?? null },
    });
  }
  if (days) await setAutomationDays(db, session.subject, days);
  await resumeRunsNeedingSignIn(db, agentJobsQueue().producer, session.subject);
  return NextResponse.json({ ok: true });
}
