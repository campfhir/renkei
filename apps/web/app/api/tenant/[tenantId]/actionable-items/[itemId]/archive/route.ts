/**
 * Archiving a card: whether it keeps occupying the feed, as opposed to the
 * decision route, which is about what happens to the suggestion. Only a
 * decided card can be archived — a `suggested` card must be dismissed or
 * approved first, so nothing leaves the feed undecided. Dismissal archives
 * in the same stroke over in the decision route; this route covers the
 * rest (executed/failed cards) and un-archiving from the history view.
 */

import { NextRequest, NextResponse } from 'next/server';
import { sql } from 'kysely';
import { getDatabase } from '@renkei/db';
import { getSessionFromRequest } from '@/lib/session';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ tenantId: string; itemId: string }> }
): Promise<NextResponse> {
  const { tenantId, itemId } = await params;

  const session = await getSessionFromRequest(request, tenantId);
  if (!session) {
    return NextResponse.json({ error: 'Not signed in' }, { status: 401 });
  }

  const dbResult = getDatabase();
  if (!dbResult.ok) {
    return NextResponse.json({ error: 'Database error' }, { status: 500 });
  }
  const db = dbResult.val;

  // Same visibility rule as the feed: a caller may archive only a tenant-wide
  // card (no owner) or their own. Without the owner predicate a signed-in user
  // could archive another user's private card by id.
  const item = await db
    .selectFrom('actionable_items')
    .select(['id', 'status', 'archived_at'])
    .where('id', '=', itemId)
    .where('tenant_id', '=', tenantId)
    .where((eb) =>
      eb.or([eb('owner_subject', 'is', null), eb('owner_subject', '=', session.subject)])
    )
    .executeTakeFirst();
  if (!item) {
    return NextResponse.json({ error: 'Item not found' }, { status: 404 });
  }
  if (item.status === 'suggested') {
    return NextResponse.json(
      { error: 'A suggested item must be dismissed or approved before it can be archived' },
      { status: 409 }
    );
  }
  if (item.archived_at !== null) {
    return NextResponse.json({ status: 'archived' });
  }

  await db
    .updateTable('actionable_items')
    .set({
      archived_at: sql`NOW()`,
      archived_by: session.subject,
      updated_at: sql`NOW()`,
    })
    .where('id', '=', itemId)
    .where('tenant_id', '=', tenantId)
    .execute();

  return NextResponse.json({ status: 'archived' });
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ tenantId: string; itemId: string }> }
): Promise<NextResponse> {
  const { tenantId, itemId } = await params;

  const session = await getSessionFromRequest(request, tenantId);
  if (!session) {
    return NextResponse.json({ error: 'Not signed in' }, { status: 401 });
  }

  const dbResult = getDatabase();
  if (!dbResult.ok) {
    return NextResponse.json({ error: 'Database error' }, { status: 500 });
  }

  // Owner-scoped like the feed and the archive POST: a private card owned by
  // another user does not match, so it cannot be unarchived by id.
  const result = await dbResult.val
    .updateTable('actionable_items')
    .set({ archived_at: null, archived_by: null, updated_at: sql`NOW()` })
    .where('id', '=', itemId)
    .where('tenant_id', '=', tenantId)
    .where((eb) =>
      eb.or([eb('owner_subject', 'is', null), eb('owner_subject', '=', session.subject)])
    )
    .executeTakeFirst();

  if (Number(result.numUpdatedRows ?? 0) === 0) {
    return NextResponse.json({ error: 'Item not found' }, { status: 404 });
  }
  return NextResponse.json({ status: 'unarchived' });
}
