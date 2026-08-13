/**
 * A mailbox owner's own correction: remove a message entirely, or send it
 * down a different cleaning path. This is the only way either can happen —
 * there is no admin equivalent. There is deliberately no "index it as-is"
 * action: automatic classification is the trusted default, and a correction
 * still goes through the normal pipeline for whatever category it's
 * corrected to — it never bypasses cleaning.
 *
 * The row is re-read server-side by (tenantId, the caller's own identity,
 * refId) rather than trusting provider/accountId from the client, per the
 * Server Actions security guidance this app follows elsewhere: the client
 * names WHICH message, the server derives everything about it from a
 * trusted source. A refId that is not this caller's own resolves as
 * "not found" — confirming it belongs to someone else would itself leak
 * information.
 */

import { NextRequest, NextResponse } from 'next/server';
import { webhookEventsQueue } from '@renkei/queue';
import { getSessionFromRequest } from '@/lib/session';
import { getIdentityEmail } from '@/lib/identity';
import { isEmailCategory, isMessageOverrideAction } from '@/lib/email-sanitizer-guards';
import { getOwnRow, setOverride } from '@renkei/email-sanitizer';
import { MICROSOFT } from '@renkei/provider-grants';
import { objectIdOfMicrosoftRefId } from '@renkei/connector-microsoft';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ tenantId: string }> }
): Promise<NextResponse> {
  const { tenantId } = await params;

  const session = await getSessionFromRequest(request, tenantId);
  if (!session) {
    return NextResponse.json({ error: 'Not signed in' }, { status: 401 });
  }
  const emailResult = await getIdentityEmail(tenantId, session.subject);
  const userEmail = emailResult.ok ? emailResult.val : null;
  if (!userEmail) {
    return NextResponse.json(
      { error: 'No email on record for your identity — sign out and back in to refresh it' },
      { status: 400 }
    );
  }

  const body: unknown = await request.json().catch(() => null);
  if (!isRecord(body) || typeof body.refId !== 'string' || !body.refId) {
    return NextResponse.json({ error: 'refId is required' }, { status: 400 });
  }
  if (typeof body.action !== 'string' || !isMessageOverrideAction(body.action)) {
    return NextResponse.json(
      { error: 'action must be one of exclude, reclassify' },
      { status: 400 }
    );
  }
  const action = body.action;
  const category =
    typeof body.category === 'string' && isEmailCategory(body.category) ? body.category : undefined;
  const senderKey =
    typeof body.senderKey === 'string' && body.senderKey.trim() ? body.senderKey.trim() : undefined;
  if (action === 'reclassify' && !category) {
    return NextResponse.json(
      { error: 'category is required for a reclassify override' },
      { status: 400 }
    );
  }

  const rowResult = await getOwnRow(tenantId, userEmail, body.refId);
  if (!rowResult.ok) {
    return NextResponse.json({ error: 'Could not read your mail review queue' }, { status: 500 });
  }
  const row = rowResult.val;
  if (!row) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  const overrideResult = await setOverride(tenantId, userEmail, row.refId, {
    action,
    category,
    senderKey,
  });
  if (!overrideResult.ok) {
    return NextResponse.json({ error: 'Could not record the override' }, { status: 500 });
  }

  // Reprocessing is wired for Microsoft mail only — the one connector this
  // pass integrates. A future connector adds its own event/handler pair
  // here; the override itself is already recorded either way.
  if (row.provider === MICROSOFT) {
    const objectId = objectIdOfMicrosoftRefId(row.refId);
    if (!objectId) {
      return NextResponse.json({ error: 'Malformed refId for this message' }, { status: 500 });
    }
    const enqueued = await webhookEventsQueue().producer.enqueue({
      tenantId,
      source: MICROSOFT,
      type: 'message-override',
      payload: {
        accountId: row.accountId,
        objectId,
        refId: row.refId,
        override: { action, category, senderKey },
      },
      // Two overrides of the same message apply in the order they were made.
      orderingKey: `microsoft/override/${row.refId}`,
    });
    if (!enqueued.ok) {
      return NextResponse.json({ error: 'Could not enqueue the override' }, { status: 500 });
    }
  }

  return NextResponse.json({ ok: true });
}
