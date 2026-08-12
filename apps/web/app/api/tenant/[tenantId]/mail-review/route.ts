/**
 * A signed-in user's own mail classification history — never another
 * user's. The identity spine (getIdentityEmail) resolves the caller's own
 * email from their session, and every downstream query filters on it; there
 * is no parameter that could widen this to someone else's mail. See
 * packages/email-sanitizer/src/persistence/log.ts for the enforcement.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSessionFromRequest } from '@/lib/session';
import { getIdentityEmail } from '@/lib/identity';
import { isEmailCategory } from '@/lib/email-sanitizer-guards';
import { listForOwner, countByCategoryForOwner } from '@renkei/email-sanitizer';

/**
 * A spot check, not a browsable archive — with good classification there's
 * rarely anything to review, so this deliberately shows only a handful at a
 * time rather than paging through everything.
 */
const MAX_PAGE_SIZE = 5;

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ tenantId: string }> }
): Promise<NextResponse> {
  const { tenantId } = await params;

  const session = await getSessionFromRequest(request, tenantId);
  if (!session) {
    return NextResponse.json({ error: 'Not signed in' }, { status: 401 });
  }

  const emailResult = await getIdentityEmail(tenantId, session.subject);
  const userEmail = emailResult.ok ? emailResult.val : null;
  if (!userEmail) {
    return NextResponse.json(
      { error: 'No email on record for your identity — sign out and back in to refresh it' },
      { status: 400 }
    );
  }

  const searchParams = request.nextUrl.searchParams;
  const categoryParam = searchParams.get('category') ?? 'human';
  if (!isEmailCategory(categoryParam)) {
    return NextResponse.json(
      { error: 'category must be one of human, system_notification, marketing' },
      { status: 400 }
    );
  }
  const pageParam = Number(searchParams.get('page') ?? '1');
  const page = Number.isFinite(pageParam) && pageParam >= 1 ? Math.trunc(pageParam) : 1;
  const pageSizeParam = Number(searchParams.get('pageSize') ?? String(MAX_PAGE_SIZE));
  const pageSize =
    Number.isFinite(pageSizeParam) && pageSizeParam >= 1
      ? Math.min(Math.trunc(pageSizeParam), MAX_PAGE_SIZE)
      : MAX_PAGE_SIZE;

  const [pageResult, countsResult] = await Promise.all([
    listForOwner(tenantId, userEmail, {
      category: categoryParam,
      limit: pageSize,
      offset: (page - 1) * pageSize,
    }),
    countByCategoryForOwner(tenantId, userEmail),
  ]);
  if (!pageResult.ok) {
    return NextResponse.json({ error: 'Could not read your mail review queue' }, { status: 500 });
  }

  return NextResponse.json({
    items: pageResult.val.items,
    totalCount: pageResult.val.totalCount,
    page,
    pageSize,
    counts: countsResult.ok ? countsResult.val : { human: 0, system_notification: 0, marketing: 0 },
  });
}
