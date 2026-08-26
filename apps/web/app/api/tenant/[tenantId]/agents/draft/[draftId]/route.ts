/**
 * One draft's status and, once it exists, its result — what the builder
 * polls while a draft is running, and what it reads on open to offer a
 * draft that finished after the person navigated away.
 *
 * Owner-scoped at the query, not filtered after: a draft carries the prose
 * someone wrote and the steps they were editing, and is nobody else's.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getDatabase } from '@renkei/db';
import { getSessionFromRequest } from '@/lib/session';
import { getDraft } from '@/lib/agents/draft-store';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ tenantId: string; draftId: string }> }
): Promise<NextResponse> {
  const { tenantId, draftId } = await params;
  const session = await getSessionFromRequest(request, tenantId);
  if (!session) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });

  const dbResult = getDatabase();
  if (!dbResult.ok) return NextResponse.json({ error: 'Database unavailable' }, { status: 500 });

  const draft = await getDraft(dbResult.val, tenantId, session.subject, draftId);
  // Someone else's draft and a draft that never existed get the same answer,
  // which is the only one that does not confirm the id.
  if (!draft) return NextResponse.json({ error: 'No such draft' }, { status: 404 });

  return NextResponse.json({ draft });
}
