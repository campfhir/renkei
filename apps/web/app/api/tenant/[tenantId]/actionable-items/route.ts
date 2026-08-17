/**
 * The card feed: a signed-in user's view of their tenant's actionable items.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getDatabase } from '@renkei/db';
import { getSessionFromRequest } from '@/lib/session';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ tenantId: string }> }
): Promise<NextResponse> {
  const { tenantId } = await params;

  const session = await getSessionFromRequest(request, tenantId);
  if (!session) {
    return NextResponse.json({ error: 'Not signed in' }, { status: 401 });
  }

  const dbResult = getDatabase();
  if (!dbResult.ok) {
    return NextResponse.json({ error: 'Database error' }, { status: 500 });
  }

  // Same visibility rule as the home-page feed: tenant-wide cards (no
  // owner) plus the caller's own; `?archived=1` widens to the history.
  const showArchived = request.nextUrl.searchParams.get('archived') === '1';
  let query = dbResult.val
    .selectFrom('actionable_items')
    .select([
      'id',
      'source',
      'kind',
      'status',
      'title',
      'summary',
      'evidence',
      'suggested_action',
      'result',
      'created_at',
      'decided_at',
      'archived_at',
    ])
    .where('tenant_id', '=', tenantId)
    .where((eb) =>
      eb.or([eb('owner_subject', 'is', null), eb('owner_subject', '=', session.subject)])
    )
    .orderBy('created_at', 'desc')
    .limit(50);
  if (!showArchived) {
    query = query.where('archived_at', 'is', null);
  }
  const items = await query.execute();

  return NextResponse.json({ items });
}
