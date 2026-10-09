/**
 * Operator shred of a person's encryption key (docs/delegate-key-design.md,
 * "Loss"): there is no recovery for a lost user key, so when a person is
 * gone or locked out for good an administrator removes their key row —
 * every delegation cascades, and every wrapping made for them, boxes
 * sealed to their public key included, is deleted. Their chats, shared
 * ones aside (each grantee holds a wrapping of their own), credentials and
 * memory become unreadable to everyone, Renkei included; their sessions
 * end so the next sign-in enrolls them afresh. Containment, not tidying:
 * the rows themselves stay until their resources go.
 */

import { NextRequest, NextResponse } from 'next/server';
import { checkAccess, ROLE_OPERATOR } from '@/lib/access';
import { getDatabase } from '@renkei/db';
import { delegateClient } from '@renkei/delegate-client';
import { recordAuditEvent } from '@/lib/audit-events';

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ slug: string; subject: string }> }
): Promise<NextResponse> {
  const { slug, subject: encoded } = await params;
  const subject = decodeURIComponent(encoded);
  const access = await checkAccess(tenantRef.id, [ROLE_OPERATOR]);
  if (!access) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (access.subject === subject) {
    return NextResponse.json(
      { error: 'Remove your own key from Preferences, not from here.' },
      { status: 400 }
    );
  }
  const dbResult = getDatabase();
  if (!dbResult.ok) return NextResponse.json({ error: 'Database error' }, { status: 500 });

  const shredded = await delegateClient().shredUserKey(tenantRef.id, subject);
  if (!shredded.ok) {
    return NextResponse.json({ error: 'The key service could not be reached.' }, { status: 503 });
  }
  await dbResult.val
    .deleteFrom('sessions')
    .where('subject', '=', subject)
    .execute();
  recordAuditEvent({
    actorSubject: access.subject,
    action: 'encryption-key.shredded',
    targetKind: 'person',
    targetLabel: subject,
  });
  void request;
  return NextResponse.json({ success: true, shredded: shredded.val });
}
