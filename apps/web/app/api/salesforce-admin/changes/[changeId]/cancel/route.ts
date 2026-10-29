/**
 * Withdraw or decline a pending Salesforce admin change request. The
 * person who asked may withdraw their own; an operator may decline anyone's,
 * with a note the requester reads. Nothing reaches the org, so there is
 * nothing to gate beyond that.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSessionFromRequest } from '@/lib/session';
import { ROLE_OPERATOR } from '@/lib/access';
import { notifyChangeOutcome } from '@/lib/admin-changes/notify';
import {
  cancelChangeRequest,
  getChangeRequestById,
  mayView,
} from '@/lib/salesforce-admin/change-requests';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ changeId: string }> }
): Promise<NextResponse> {
  const { changeId } = await params;

  const session = await getSessionFromRequest(request);
  if (!session) {
    return NextResponse.json({ error: 'Not signed in' }, { status: 401 });
  }

  const operator = session.roles.includes(ROLE_OPERATOR);
  const change = await getChangeRequestById(changeId);
  // Someone else's request is not found, not forbidden — unless they review them.
  if (!change || !mayView(change, { subject: session.subject, operator })) {
    return NextResponse.json({ error: 'Change request not found' }, { status: 404 });
  }

  const body: unknown = await request.json().catch(() => ({}));
  const note =
    typeof body === 'object' && body !== null && 'note' in body && typeof body.note === 'string'
      ? body.note
      : '';

  if (!(await cancelChangeRequest(session.subject, change.id, { operator, note }))) {
    return NextResponse.json(
      { error: 'Only a change request waiting for review can be cancelled.' },
      { status: 409 }
    );
  }
  if (change.subject !== session.subject) {
    notifyChangeOutcome({
      connector: 'salesforce-admin',
      changeId: change.id,
      title: change.title,
      requester: change.subject,
      approver: null,
      outcome: 'declined',
      note: note.trim() || null,
    });
  }
  return NextResponse.json({ status: 'cancelled' });
}
