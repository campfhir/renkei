/**
 * One browser secret: unlock or lock it (POST with an action), or revoke
 * it (DELETE). Unlocking forwards the person's passphrase to the sandbox
 * worker for the length of the request — the worker derives the key,
 * proves it opens the secret, and holds it in memory for the window asked
 * for; this process keeps nothing.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSessionFromRequest } from '@/lib/session';
import { recordAuditEvent } from '@/lib/audit-events';
import {
  clientFailure,
  sandboxBrowserEnabled,
  sbSecretLock,
  sbSecretRevoke,
  sbSecretUnlock,
} from '@/lib/sandbox/service-client';
import { logger } from '@/lib/logger';
import { isRecord } from '@renkei/guards';

const HOUR_MS = 60 * 60_000;

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ secretId: string }> }
): Promise<NextResponse> {
  const { secretId } = await params;
  const session = await getSessionFromRequest(request);
  if (!session) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });
  if (!(await sandboxBrowserEnabled()))
    return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const body: unknown = await request.json().catch(() => null);
  if (!isRecord(body)) {
    return NextResponse.json({ error: 'A JSON body is required' }, { status: 400 });
  }
  const target = { subject: session.subject };

  if (body.action === 'unlock') {
    const unlockHours = typeof body.unlockHours === 'number' ? body.unlockHours : undefined;
    const unlocked = await sbSecretUnlock(target, {
      id: secretId,
      passphrase: typeof body.passphrase === 'string' ? body.passphrase : '',
      ...(unlockHours ? { unlockMs: unlockHours * HOUR_MS } : {}),
    });
    if (!unlocked.ok) {
      const failure = clientFailure(unlocked.err);
      if (failure.status !== 400 && failure.status !== 404) {
        logger[failure.status >= 500 ? 'error' : 'warn'](
          'Sandbox request failed ({status}): {error}',
          {
            component: 'api/sandbox/secrets',
            subject: session.subject,
            secretId,
            operation: 'unlocked',
            status: failure.status,
            error:
              'message' in unlocked.err && unlocked.err.message
                ? unlocked.err.message
                : failure.message,
          }
        );
      }
      return NextResponse.json({ error: failure.message }, { status: failure.status });
    }
    recordAuditEvent({
      actorSubject: session.subject,
      action: 'sandbox.secret.unlocked',
      targetKind: 'sandbox_secret',
      targetLabel: unlocked.val.name,
      details: { unlockedUntil: unlocked.val.unlockedUntil },
    });
    return NextResponse.json({ secret: unlocked.val });
  }

  if (body.action === 'lock') {
    const locked = await sbSecretLock(target, secretId);
    if (!locked.ok) {
      const failure = clientFailure(locked.err);
      if (failure.status !== 400 && failure.status !== 404) {
        logger[failure.status >= 500 ? 'error' : 'warn'](
          'Sandbox request failed ({status}): {error}',
          {
            component: 'api/sandbox/secrets',
            subject: session.subject,
            secretId,
            operation: 'locked',
            status: failure.status,
            error:
              'message' in locked.err && locked.err.message ? locked.err.message : failure.message,
          }
        );
      }
      return NextResponse.json({ error: failure.message }, { status: failure.status });
    }
    recordAuditEvent({
      actorSubject: session.subject,
      action: 'sandbox.secret.locked',
      targetKind: 'sandbox_secret',
      targetLabel: locked.val.name,
    });
    return NextResponse.json({ secret: locked.val });
  }

  return NextResponse.json({ error: 'action must be "unlock" or "lock"' }, { status: 400 });
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ secretId: string }> }
): Promise<NextResponse> {
  const { secretId } = await params;
  const session = await getSessionFromRequest(request);
  if (!session) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });
  if (!(await sandboxBrowserEnabled()))
    return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const revoked = await sbSecretRevoke({ subject: session.subject }, secretId);
  if (!revoked.ok) {
    const failure = clientFailure(revoked.err);
    if (failure.status !== 400 && failure.status !== 404) {
      logger[failure.status >= 500 ? 'error' : 'warn'](
        'Sandbox request failed ({status}): {error}',
        {
          component: 'api/sandbox/secrets',
          subject: session.subject,
          secretId,
          operation: 'revoked',
          status: failure.status,
          error:
            'message' in revoked.err && revoked.err.message ? revoked.err.message : failure.message,
        }
      );
    }
    return NextResponse.json({ error: failure.message }, { status: failure.status });
  }
  recordAuditEvent({
    actorSubject: session.subject,
    action: 'sandbox.secret.revoked',
    targetKind: 'sandbox_secret',
    targetLabel: revoked.val.name,
  });
  return NextResponse.json({ ok: true });
}
