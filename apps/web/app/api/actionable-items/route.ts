/**
 * The card feed: a signed-in user's view of their tenant's actionable items.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getDataStore } from '@renkei/db';
import { wrapAsync } from '@campfhir/safe-functions/helpers';
import { getSessionFromRequest } from '@/lib/session';

export async function GET(request: NextRequest): Promise<NextResponse> {
  const session = await getSessionFromRequest(request);
  if (!session) {
    return NextResponse.json({ error: 'Not signed in' }, { status: 401 });
  }

  // Same visibility rule as the home-page feed: tenant-wide cards (no
  // owner) plus the caller's own; `?archived=1` widens to the history.
  const showArchived = request.nextUrl.searchParams.get('archived') === '1';
  const read = await wrapAsync(
    () =>
      getDataStore().actionableItems.listVisible(session.subject, {
        limit: 50,
        includeArchived: showArchived,
      }),
    'DB_ERROR' as const
  );
  if (!read.ok) {
    return NextResponse.json({ error: 'Database error' }, { status: 500 });
  }
  const items = read.val.map((item) => ({
    id: item.id,
    source: item.source,
    kind: item.kind,
    status: item.status,
    title: item.title,
    summary: item.summary,
    evidence: item.evidence,
    suggested_action: item.suggestedAction,
    result: item.result,
    created_at: item.createdAt,
    decided_at: item.decidedAt,
    archived_at: item.archivedAt,
  }));

  return NextResponse.json({ items });
}
