/**
 * A person's own encryption key (docs/user-encryption-keys-design.md,
 * "Your own key"): what it is right now, and the four things they can do
 * to it. Strictly their own — the subject comes from the session, never
 * from the body, so no request shape touches somebody else's key.
 *
 * GET  → the status the preferences section shows.
 * POST → `{ action: 'adopt' | 'unlock' | 'lock' | 'revert', passphrase?, hours? }`:
 *   adopt   switch to (or change) a passphrase-derived key; everything
 *           they hold is rewrapped, and the key is left unlocked;
 *   unlock  hold the key for `hours` (default 24, at most 30 days);
 *   lock    forget it now;
 *   revert  back to the managed key, with the passphrase as proof.
 *
 * The passphrase travels in the body of this one request to the delegate,
 * which derives the key from it; it is never stored and never logged, and
 * this process never holds the key it derives.
 */

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { OWN_KEY_UNLOCK_DEFAULT_MS, OWN_KEY_UNLOCK_MAX_MS } from '@renkei/user-keys';
import { delegateClient } from '@renkei/delegate-client';
import { chatRequestContext, jsonError, readJsonBody } from '@/lib/chat/route-support';
import { recordAuditEvent } from '@/lib/audit-events';
import { toEncryptionKeyView } from '@/lib/encryption-key-view';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ tenantId: string }> }
): Promise<Response> {
  const { tenantId } = await params;
  const ready = await chatRequestContext(request, tenantId);
  if (!ready.ok) return ready.response;
  const { session } = ready.context;
  const status = await delegateClient().getUserKeyStatus(tenantId, session.subject);
  if (!status.ok) return jsonError(503, 'delegate', 'The key service could not be reached.');
  return NextResponse.json(toEncryptionKeyView(status.val));
}

function unlockMsOf(hours: unknown): number {
  if (typeof hours !== 'number' || !Number.isFinite(hours) || hours <= 0) {
    return OWN_KEY_UNLOCK_DEFAULT_MS;
  }
  return Math.min(OWN_KEY_UNLOCK_MAX_MS, Math.round(hours * 60 * 60_000));
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ tenantId: string }> }
): Promise<Response> {
  const { tenantId } = await params;
  const ready = await chatRequestContext(request, tenantId);
  if (!ready.ok) return ready.response;
  const { session } = ready.context;
  const keys = delegateClient();
  const body = await readJsonBody(request);
  const action = body.action;
  const passphrase = typeof body.passphrase === 'string' ? body.passphrase : '';
  const unlockMs = unlockMsOf(body.hours);

  if (action === 'lock') {
    const status = await keys.lockOwnKey(tenantId, session.subject);
    if (!status.ok) return jsonError(503, 'delegate', 'The key service could not be reached.');
    recordAuditEvent({ tenantId, actorSubject: session.subject, action: 'encryption-key.locked' });
    return NextResponse.json(toEncryptionKeyView(status.val));
  }
  if (!passphrase) return jsonError(400, 'passphrase', 'Enter your passphrase.');

  if (action === 'adopt') {
    const adopted = await keys.adoptOwnKey(tenantId, session.subject, passphrase, { unlockMs });
    if (!adopted.ok) {
      switch (adopted.err.type) {
        case 'PASSPHRASE_TOO_SHORT':
          return jsonError(400, 'passphrase', 'Use at least 12 characters.');
        case 'PASSPHRASE_TOO_LONG':
          return jsonError(400, 'passphrase', 'That passphrase is too long.');
        case 'KEY_LOCKED':
          return jsonError(409, 'locked', 'Unlock your current key first.');
        default:
          return jsonError(500, 'key', 'Your key could not be changed. Nothing was altered.');
      }
    }
    recordAuditEvent({ tenantId, actorSubject: session.subject, action: 'encryption-key.adopted' });
    return NextResponse.json(toEncryptionKeyView(adopted.val));
  }
  if (action === 'unlock') {
    const unlocked = await keys.unlockOwnKey(tenantId, session.subject, passphrase, { unlockMs });
    if (!unlocked.ok) {
      switch (unlocked.err.type) {
        case 'WRONG_PASSPHRASE':
          return jsonError(403, 'wrong-passphrase', 'That is not your passphrase.');
        case 'NOT_OWN_KEY':
        case 'NO_USER_KEY':
          return jsonError(
            409,
            'managed',
            'Your key is managed by Renkei; there is nothing to unlock.'
          );
        default:
          return jsonError(500, 'key', 'Your key could not be unlocked.');
      }
    }
    recordAuditEvent({
      tenantId,
      actorSubject: session.subject,
      action: 'encryption-key.unlocked',
    });
    return NextResponse.json(toEncryptionKeyView(unlocked.val));
  }
  if (action === 'revert') {
    const reverted = await keys.revertToManagedKey(tenantId, session.subject, passphrase);
    if (!reverted.ok) {
      switch (reverted.err.type) {
        case 'WRONG_PASSPHRASE':
          return jsonError(403, 'wrong-passphrase', 'That is not your passphrase.');
        case 'NOT_OWN_KEY':
        case 'NO_USER_KEY':
          return jsonError(409, 'managed', 'Your key is already managed by Renkei.');
        default:
          return jsonError(500, 'key', 'Your key could not be changed. Nothing was altered.');
      }
    }
    recordAuditEvent({
      tenantId,
      actorSubject: session.subject,
      action: 'encryption-key.reverted',
    });
    return NextResponse.json(toEncryptionKeyView(reverted.val));
  }
  return jsonError(400, 'invalid', 'Unknown action.');
}
