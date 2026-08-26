/**
 * "I loaded that draft." Called when the builder actually puts a draft's
 * steps into the editor, so it stops being offered on the next open.
 *
 * Separate from the GET that offers it, because being SHOWN a draft and
 * TAKING it are different acts: dismissing the offer must leave the draft
 * available, since "not now" and "never" are different answers.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getDatabase } from '@renkei/db';
import { getSessionFromRequest } from '@/lib/session';
import { consumeDraft } from '@/lib/agents/draft-store';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ tenantId: string; draftId: string }> }
): Promise<NextResponse> {
  const { tenantId, draftId } = await params;
  const session = await getSessionFromRequest(request, tenantId);
  if (!session) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });

  const dbResult = getDatabase();
  if (!dbResult.ok) return NextResponse.json({ error: 'Database unavailable' }, { status: 500 });

  // Owner-scoped inside consumeDraft, so a draft id belonging to somebody
  // else is a no-op rather than an error that confirms the id exists.
  await consumeDraft(dbResult.val, tenantId, session.subject, draftId);
  return NextResponse.json({ ok: true });
}
