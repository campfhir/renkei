/**
 * Archiving a card: whether it keeps occupying the feed, as opposed to the
 * decision route, which is about what happens to the suggestion. Only a
 * decided card can be archived — a `suggested` card must be dismissed or
 * approved first, so nothing leaves the feed undecided. Dismissal archives
 * in the same stroke over in the decision route; this route covers the
 * rest (executed/failed cards) and un-archiving from the history view.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getDataStore } from '@renkei/db';
import { wrapAsync } from '@campfhir/safe-functions/helpers';
import { getSessionFromRequest } from '@/lib/session';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ itemId: string }> }
): Promise<NextResponse> {
  const { itemId } = await params;

  const session = await getSessionFromRequest(request);
  if (!session) {
    return NextResponse.json({ error: 'Not signed in' }, { status: 401 });
  }

  const store = getDataStore().actionableItems;

  // Same visibility rule as the feed: a caller may archive only a tenant-wide
  // card (no owner) or their own. Without the owner predicate a signed-in user
  // could archive another user's private card by id.
  const found = await wrapAsync(
    () => store.findVisible(session.subject, itemId),
    'DB_ERROR' as const
  );
  if (!found.ok) {
    return NextResponse.json({ error: 'Database error' }, { status: 500 });
  }
  const item = found.val;
  if (!item) {
    return NextResponse.json({ error: 'Item not found' }, { status: 404 });
  }
  if (item.status === 'suggested') {
    return NextResponse.json(
      { error: 'A suggested item must be dismissed or approved before it can be archived' },
      { status: 409 }
    );
  }
  if (item.archivedAt !== null) {
    return NextResponse.json({ status: 'archived' });
  }

  await store.archive(itemId, session.subject);

  return NextResponse.json({ status: 'archived' });
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ itemId: string }> }
): Promise<NextResponse> {
  const { itemId } = await params;

  const session = await getSessionFromRequest(request);
  if (!session) {
    return NextResponse.json({ error: 'Not signed in' }, { status: 401 });
  }

  // Owner-scoped like the feed and the archive POST: a private card owned by
  // another user does not match, so it cannot be unarchived by id.
  const result = await wrapAsync(
    () => getDataStore().actionableItems.unarchive(session.subject, itemId),
    'DB_ERROR' as const
  );
  if (!result.ok) {
    return NextResponse.json({ error: 'Database error' }, { status: 500 });
  }

  if (result.val === 0) {
    return NextResponse.json({ error: 'Item not found' }, { status: 404 });
  }
  return NextResponse.json({ status: 'unarchived' });
}
