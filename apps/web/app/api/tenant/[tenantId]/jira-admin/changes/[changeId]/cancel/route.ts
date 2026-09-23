/**
 * Withdraw a pending Jira admin change request. Owner-only, like apply;
 * nothing reaches Jira, so there is nothing to gate beyond that.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getDatabase } from '@renkei/db';
import { getSessionFromRequest } from '@/lib/session';
import { cancelChangeRequest, getChangeRequest } from '@/lib/jira-admin/change-requests';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ tenantId: string; changeId: string }> }
): Promise<NextResponse> {
  const { tenantId, changeId } = await params;

  const session = await getSessionFromRequest(request, tenantId);
  if (!session) {
    return NextResponse.json({ error: 'Not signed in' }, { status: 401 });
  }

  const dbResult = getDatabase();
  if (!dbResult.ok) {
    return NextResponse.json({ error: 'Database error' }, { status: 500 });
  }
  const db = dbResult.val;

  const change = await getChangeRequest(db, tenantId, session.subject, changeId);
  if (!change) {
    return NextResponse.json({ error: 'Change request not found' }, { status: 404 });
  }
  if (!(await cancelChangeRequest(db, tenantId, session.subject, change.id))) {
    return NextResponse.json(
      { error: 'Only a change request waiting for review can be cancelled.' },
      { status: 409 }
    );
  }
  return NextResponse.json({ status: 'cancelled' });
}
