/**
 * Enrollment: the browser generated the person's user key, keypair and
 * automation key, wrapped the private and automation keys under the user
 * key, and sealed the user key (session) and the automation key
 * (automation) to every live delegate instance. This route hands all of
 * that to the delegate, which checks it against the delegation sealed to
 * itself, moves the person's rows from a pre-enrollment key if they had
 * one, and records it. No key passes through here in the clear: public
 * key, wrappings and sealed boxes only.
 */

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { delegateClient } from '@renkei/delegate-client';
import { agentJobsQueue } from '@renkei/queue';
import { chatRequestContext, jsonError, readJsonBody } from '@/lib/chat/route-support';
import { resumeRunsNeedingSignIn } from '@/lib/agents/needs-sign-in';
import { recordAuditEvent } from '@/lib/audit-events';
import {
  AUTOMATION_WINDOW_DEFAULT_DAYS,
  automationDaysOfBody,
  keyMaterialOf,
  sealedDelegationsOf,
  setAutomationDays,
} from '@/lib/keys/status';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ tenantId: string }> }
): Promise<Response> {
  const ready = await chatRequestContext(request, tenantId);
  if (!ready.ok) return ready.response;
  const { db, session } = ready.context;
  const body = await readJsonBody(request);
  const publicKey = keyMaterialOf(body.publicKey, 128);
  const wrappedPrivateKey = keyMaterialOf(body.wrappedPrivateKey);
  const wrappedAutomationKey = keyMaterialOf(body.wrappedAutomationKey);
  const sessionDelegations = sealedDelegationsOf(body.session);
  const automation = sealedDelegationsOf(body.automation ?? []);
  if (
    !publicKey ||
    !wrappedPrivateKey ||
    !wrappedAutomationKey ||
    !sessionDelegations ||
    !automation
  ) {
    return jsonError(400, 'bad_request', 'The enrollment is incomplete.');
  }
  const days = automationDaysOfBody(body.automationDays) ?? AUTOMATION_WINDOW_DEFAULT_DAYS;
  const enrolled = await delegateClient().enroll({
    subject: session.subject,
    sessionId: session.id,
    publicKey,
    wrappedPrivateKey,
    wrappedAutomationKey,
    session: sessionDelegations,
    automation,
    automationUntil: new Date(Date.now() + days * 24 * 60 * 60_000),
    passphrase: typeof body.passphrase === 'string' ? body.passphrase : undefined,
  });
  if (!enrolled.ok) {
    switch (enrolled.err.type) {
      case 'ALREADY_ENROLLED':
        return jsonError(409, 'enrolled', 'This account already has a key.');
      case 'WRONG_PASSPHRASE':
        return jsonError(403, 'passphrase', 'That passphrase is not right.');
      case 'KEY_LOCKED':
        return jsonError(
          423,
          'passphrase',
          'Your earlier key is passphrase-protected; enter the passphrase to move your data.'
        );
      case 'MIGRATION_UNAVAILABLE':
        return jsonError(
          503,
          'migration',
          'Your existing data cannot be moved right now; an administrator must finish the key migration first.'
        );
      case 'BAD_DELEGATION':
      case 'KEY_MISMATCH':
        return jsonError(400, 'bad_request', 'The keys this browser sent do not fit together.');
      default:
        return jsonError(503, 'delegate', 'The key service could not be reached.');
    }
  }
  await setAutomationDays(db, tenantId, session.subject, days);
  await resumeRunsNeedingSignIn(db, agentJobsQueue().producer, tenantId, session.subject);
  recordAuditEvent({ actorSubject: session.subject, action: 'encryption-key.enrolled' });
  return NextResponse.json({ version: enrolled.val.version, migrated: enrolled.val.migrated });
}
