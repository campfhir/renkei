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

  const items = await dbResult.val
    .selectFrom('actionable_items')
    .select([
      'id',
      'source',
      'status',
      'title',
      'summary',
      'evidence',
      'suggested_action',
      'result',
      'created_at',
      'decided_at',
    ])
    .where('tenant_id', '=', tenantId)
    .orderBy('created_at', 'desc')
    .limit(50)
    .execute();

  return NextResponse.json({ items });
}
